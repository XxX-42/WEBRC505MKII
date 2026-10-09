#include "webrc/dsp/rhythm.hpp"

#include <algorithm>
#include <cmath>
#include <limits>

namespace webrc::dsp {
namespace {

static_assert(std::atomic<std::uint32_t>::is_always_lock_free,
              "RhythmRenderer command handoff requires lock-free uint32 atomics");

constexpr std::uint64_t kSeedSalt = 0x9e3779b97f4a7c15ULL;

constexpr CleanRoomKitProfile makeKit(const char* name,
                                      float kickStart, float kickEnd, float kickSweep, float kickDecay,
                                      float snareBody, float snareBodyDecay, float snareNoiseDecay,
                                      float snareNoise, float hatHz, float hatDecay, float hatNoise,
                                      float modalHz, float modalDecay, float modalTone, float modalNoise,
                                      std::uint64_t seed) noexcept {
    CleanRoomKitProfile profile{};
    profile.name = name;
    profile.kick = {kickStart, kickEnd, kickSweep, kickDecay, 0.82f};
    profile.snare = {snareBody, snareBodyDecay, snareNoiseDecay, snareNoise,
                     0.70f, 0.0f, seed};
    profile.closedHat = {hatHz, hatDecay, hatNoise, 0.42f, 0.0f, seed ^ 0x71d4a35bULL};
    profile.openHat = {hatHz * 0.92f, std::min(0.7f, hatDecay * 2.8f),
                       std::min(0.9f, hatNoise * 1.08f), 0.50f, 0.08f,
                       seed ^ 0xb5297a4dULL};
    profile.modal = {modalHz, modalDecay, modalTone, modalNoise, 0.58f, 0.0f,
                     seed ^ 0x68e31da4ULL};
    profile.brushSweepAmplitude = name[0] == 'B' ? 0.34f :
        0.13f + static_cast<float>(seed & 3ULL) * 0.015f;
    profile.brushSweepSeconds = name[0] == 'B' ? 0.42f :
        0.14f + static_cast<float>((seed - 0x5a17d100ULL) % 3ULL) * 0.025f;
    profile.brushSweepHighpassHz = name[0] == 'B' ? 2400.0f :
        4200.0f + static_cast<float>((seed - 0x5a17d100ULL) % 5ULL) * 300.0f;
    return profile;
}

constexpr std::array<CleanRoomKitProfile, 16> kCleanRoomKits{{
    makeKit("STUDIO", 142, 47, .075f, .56f, 190, .28f, .20f, .62f, 6100, .16f, .42f, 82, .62f, .40f, .02f, 0x5a17d101ULL),
    makeKit("LIVE", 154, 45, .085f, .72f, 176, .34f, .25f, .70f, 5600, .23f, .46f, 74, .85f, .46f, .03f, 0x5a17d102ULL),
    makeKit("LIGHT", 126, 54, .060f, .40f, 220, .22f, .16f, .50f, 7200, .12f, .36f, 96, .44f, .35f, .01f, 0x5a17d103ULL),
    makeKit("HEAVY", 168, 42, .090f, .82f, 160, .39f, .29f, .78f, 6600, .25f, .48f, 66, 1.05f, .52f, .04f, 0x5a17d104ULL),
    makeKit("ROCK", 150, 44, .080f, .68f, 184, .32f, .23f, .69f, 6400, .19f, .43f, 78, .78f, .44f, .025f, 0x5a17d105ULL),
    makeKit("METAL", 188, 38, .045f, .52f, 235, .20f, .13f, .86f, 8100, .13f, .56f, 58, .58f, .58f, .02f, 0x5a17d106ULL),
    makeKit("JAZZ", 118, 52, .070f, .48f, 205, .36f, .26f, .48f, 5400, .40f, .38f, 110, 1.20f, .33f, .01f, 0x5a17d107ULL),
    makeKit("BRUSH", 112, 56, .095f, .42f, 248, .42f, .33f, .38f, 4700, .48f, .31f, 126, 1.35f, .26f, .015f, 0x5a17d108ULL),
    makeKit("CAJON", 132, 63, .055f, .36f, 310, .24f, .17f, .38f, 5700, .20f, .34f, 148, .72f, .30f, .02f, 0x5a17d109ULL),
    makeKit("DRUM&BASS", 170, 46, .050f, .48f, 198, .18f, .14f, .82f, 9200, .11f, .52f, 64, .54f, .58f, .01f, 0x5a17d10aULL),
    makeKit("R&B", 136, 50, .080f, .62f, 174, .31f, .25f, .54f, 5900, .22f, .40f, 70, .76f, .36f, .02f, 0x5a17d10bULL),
    makeKit("DANCE", 184, 43, .042f, .58f, 212, .16f, .14f, .90f, 7600, .15f, .50f, 60, .62f, .57f, .03f, 0x5a17d10cULL),
    makeKit("TECHNO", 196, 40, .038f, .63f, 228, .17f, .12f, .88f, 8800, .12f, .54f, 54, .56f, .61f, .02f, 0x5a17d10dULL),
    makeKit("DANCE BEATS", 162, 44, .062f, .55f, 188, .24f, .20f, .74f, 7000, .18f, .44f, 72, .74f, .48f, .025f, 0x5a17d10eULL),
    makeKit("HIPHOP", 128, 49, .090f, .78f, 152, .27f, .30f, .58f, 5200, .26f, .37f, 68, .92f, .31f, .045f, 0x5a17d10fULL),
    makeKit("808+909", 205, 36, .030f, .50f, 260, .15f, .12f, .94f, 9400, .10f, .58f, 48, .48f, .65f, .015f, 0x5a17d110ULL),
}};

[[nodiscard]] std::uint64_t eventSeed(std::uint32_t kitIndex, std::uint64_t frame,
                                      RhythmInstrument instrument,
                                      std::uint64_t ordinal) noexcept {
    return kSeedSalt ^ (static_cast<std::uint64_t>(kitIndex + 1U) * 0xd6e8feb86659fd93ULL) ^
           frame ^ (static_cast<std::uint64_t>(instrument) << 40U) ^ ordinal;
}

[[nodiscard]] float scaled(float value, float scale) noexcept {
    return std::clamp(value * scale, 0.0f, 1.0f);
}

[[nodiscard]] bool isVariation(RhythmSection section) noexcept {
    return section >= RhythmSection::VariationA && section <= RhythmSection::VariationD;
}

} // namespace

std::uint32_t cleanRoomKitCount() noexcept {
    return static_cast<std::uint32_t>(kCleanRoomKits.size());
}

const CleanRoomKitProfile* cleanRoomKitProfile(std::uint32_t index) noexcept {
    return index < kCleanRoomKits.size() ? &kCleanRoomKits[index] : nullptr;
}

bool RhythmRenderer::prepare(const ProcessSpec& spec, double bpm) noexcept {
    if (!validProcessSpec(spec) || spec.channels != 2 ||
        !std::isfinite(bpm) || bpm < 10.0 || bpm > 400.0 ||
        !voices_.prepare(spec)) {
        prepared_ = false;
        return false;
    }
    spec_ = spec;
    bpm_ = static_cast<double>(std::llround(bpm * 65536.0)) / 65536.0;
    framesPerTick_ = static_cast<double>(spec.sampleRate) * 60.0 /
                     (bpm_ * kRhythmTicksPerQuarter);
    kitIndex_ = std::min<std::uint32_t>(kitIndex_, cleanRoomKitCount() - 1U);
    kit_ = *cleanRoomKitProfile(kitIndex_);
    stagedCount_ = 0;
    stagedCursor_ = 0;
    brushSweepVoices_ = {};
    pendingFlags_.store(0, std::memory_order_relaxed);
    pendingVariation_.store(0, std::memory_order_relaxed);
    pendingTempoQ16_16_.store(0, std::memory_order_relaxed);
    startRequested_ = false;
    playbackArmed_ = false;
    hasExpectedBlockFrame_ = false;
    playing_ = false;
    section_ = RhythmSection::Stopped;
    prepared_ = true;
    return true;
}

void RhythmRenderer::reset() noexcept {
    voices_.reset();
    brushSweepVoices_ = {};
    stagedCount_ = 0;
    stagedCursor_ = 0;
    barOriginFrame_ = 0;
    nextBarFrame_ = 0;
    barOriginExactFrame_ = 0.0;
    nextBarExactFrame_ = 0.0;
    barIndex_ = 0;
    triggeredEvents_ = 0;
    lastTriggeredFrame_ = 0;
    variation_ = 0;
    section_ = RhythmSection::Stopped;
    startRequested_ = false;
    playbackArmed_ = false;
    hasExpectedBlockFrame_ = false;
    playing_ = false;
    pendingFlags_.store(0, std::memory_order_relaxed);
    pendingVariation_.store(0, std::memory_order_relaxed);
    pendingTempoQ16_16_.store(0, std::memory_order_relaxed);
}

bool RhythmRenderer::validatePattern(const RhythmPatternView& pattern) const noexcept {
    if (pattern.numerator == 0 || pattern.numerator > 32 ||
        (pattern.denominator != 4 && pattern.denominator != 8) ||
        !std::isfinite(pattern.swingAmount) || pattern.swingAmount < 0.0f ||
        pattern.swingAmount > 1.0f) {
        return false;
    }
    const auto barTicks = static_cast<std::uint32_t>(pattern.numerator) *
                          4U * kRhythmTicksPerQuarter / pattern.denominator;
    const auto validList = [barTicks, swingAmount = pattern.swingAmount](const RhythmEventList& list) noexcept {
        if (!list.events || list.count == 0 || list.count > kMaxEventsPerSection) return false;
        std::uint32_t previousTick = 0;
        std::uint8_t previousInstrument = 0;
        bool first = true;
        for (std::uint32_t index = 0; index < list.count; ++index) {
            const auto& event = list.events[index];
            const auto instrument = static_cast<std::uint8_t>(event.instrument);
            if (event.tick >= barTicks || event.velocity == 0 ||
                instrument >= static_cast<std::uint8_t>(RhythmInstrument::Count)) return false;
            if (event.swingable && (event.tick % kRhythmTicksPerQuarter != kRhythmTicksPerQuarter / 2U ||
                (swingAmount > 0.0f && event.tick + kRhythmTicksPerQuarter / 3U >= barTicks))) return false;
            if (event.instrument == RhythmInstrument::BrushSweep) {
                if (event.durationTicks == 0 || event.durationTicks > barTicks ||
                    event.durationTicks % (kRhythmTicksPerQuarter / 4U) != 0) return false;
            } else if (event.durationTicks != 0) {
                return false;
            }
            if (!first && (event.tick < previousTick ||
                (event.tick == previousTick && instrument <= previousInstrument))) return false;
            previousTick = event.tick;
            previousInstrument = instrument;
            first = false;
        }
        return true;
    };
    for (const auto& variation : pattern.variations) {
        if (!validList(variation)) return false;
    }
    return validList(pattern.intro) && validList(pattern.fill) && validList(pattern.ending);
}

bool RhythmRenderer::setPattern(const RhythmPatternView* pattern) noexcept {
    if (!prepared_ || playing_ || playbackArmed_ || startRequested_ || !pattern ||
        !validatePattern(*pattern)) return false;
    pattern_ = pattern;
    return true;
}

bool RhythmRenderer::setKit(std::uint32_t kitIndex) noexcept {
    const auto* profile = cleanRoomKitProfile(kitIndex);
    if (!prepared_ || playing_ || playbackArmed_ || startRequested_ || !profile) return false;
    kitIndex_ = kitIndex;
    kit_ = *profile;
    return true;
}

bool RhythmRenderer::startAtFrame(std::uint64_t absoluteFrame, bool playIntro) noexcept {
    if (!prepared_ || !pattern_ || playing_ || playbackArmed_ || startRequested_) return false;
    requestedStartFrame_ = absoluteFrame;
    startWithIntro_ = playIntro;
    startRequested_ = true;
    return true;
}

bool RhythmRenderer::queueVariation(std::uint8_t variation) noexcept {
    if (!prepared_ || variation > 3) return false;
    pendingVariation_.store(static_cast<std::uint32_t>(variation) + 1U, std::memory_order_release);
    return true;
}

bool RhythmRenderer::queueFill() noexcept {
    if (!prepared_) return false;
    pendingFlags_.fetch_or(FillPending, std::memory_order_release);
    return true;
}

bool RhythmRenderer::queueEnding() noexcept {
    if (!prepared_) return false;
    pendingFlags_.fetch_or(EndingPending, std::memory_order_release);
    return true;
}

bool RhythmRenderer::queueStop() noexcept {
    if (!prepared_) return false;
    pendingFlags_.fetch_or(StopPending, std::memory_order_release);
    return true;
}

bool RhythmRenderer::queueTempo(double bpm) noexcept {
    if (!prepared_ || !std::isfinite(bpm) || bpm < 10.0 || bpm > 400.0) return false;
    const auto q16 = static_cast<std::uint32_t>(std::llround(bpm * 65536.0));
    if (q16 == 0U) return false;
    pendingTempoQ16_16_.store(q16, std::memory_order_release);
    return true;
}

std::uint64_t RhythmRenderer::frameForTicks(std::uint64_t ticks) const noexcept {
    if (!std::isfinite(framesPerTick_) || framesPerTick_ <= 0.0) {
        return std::numeric_limits<std::uint64_t>::max();
    }
    const double frames = std::round(static_cast<double>(ticks) * framesPerTick_);
    if (!std::isfinite(frames) || frames < 0.0 ||
        frames >= static_cast<double>(std::numeric_limits<std::uint64_t>::max())) {
        return std::numeric_limits<std::uint64_t>::max();
    }
    return static_cast<std::uint64_t>(frames);
}

std::uint64_t RhythmRenderer::absoluteFrameAt(double exactFrame) const noexcept {
    if (!std::isfinite(exactFrame) || exactFrame < 0.0 ||
        exactFrame >= static_cast<double>(std::numeric_limits<std::uint64_t>::max())) {
        return std::numeric_limits<std::uint64_t>::max();
    }
    const auto rounded = std::round(exactFrame);
    if (rounded >= static_cast<double>(std::numeric_limits<std::uint64_t>::max())) {
        return std::numeric_limits<std::uint64_t>::max();
    }
    return static_cast<std::uint64_t>(rounded);
}

void RhythmRenderer::applyPendingTempo() noexcept {
    const auto q16 = pendingTempoQ16_16_.exchange(0, std::memory_order_acquire);
    if (q16 == 0) return;
    bpm_ = static_cast<double>(q16) / 65536.0;
    framesPerTick_ = static_cast<double>(spec_.sampleRate) * 60.0 /
                     (bpm_ * kRhythmTicksPerQuarter);
}

bool RhythmRenderer::beginPlayback(std::uint64_t currentFrame) noexcept {
    if (!pattern_) return false;
    playing_ = true;
    playbackArmed_ = false;
    barIndex_ = 0;
    variation_ = 0;
    section_ = startWithIntro_ ? RhythmSection::Intro : RhythmSection::VariationA;
    barOriginFrame_ = requestedStartFrame_;
    if (barOriginFrame_ > currentFrame) return false;
    if (currentFrame > requestedStartFrame_) requestedStartFrame_ = currentFrame;
    barOriginFrame_ = requestedStartFrame_;
    barOriginExactFrame_ = static_cast<double>(requestedStartFrame_);
    applyPendingTempo();
    const auto ticksPerBar = static_cast<std::uint64_t>(pattern_->numerator) *
                             4U * kRhythmTicksPerQuarter / pattern_->denominator;
    nextBarExactFrame_ = barOriginExactFrame_ + static_cast<double>(ticksPerBar) * framesPerTick_;
    nextBarFrame_ = absoluteFrameAt(nextBarExactFrame_);
    if (nextBarFrame_ == std::numeric_limits<std::uint64_t>::max()) return false;
    stagedCount_ = 0;
    stagedCursor_ = 0;
    brushSweepVoices_ = {};
    triggeredEvents_ = 0;
    lastTriggeredFrame_ = 0;
    voices_.reset();
    return loadSectionEvents(barOriginFrame_);
}

bool RhythmRenderer::beginNextBar(std::uint64_t barStartFrame) noexcept {
    if (barIndex_ == std::numeric_limits<std::uint64_t>::max()) return false;
    ++barIndex_;
    if (section_ == RhythmSection::Ending) {
        playing_ = false;
        section_ = RhythmSection::Stopped;
        stagedCount_ = 0;
        stagedCursor_ = 0;
        return true;
    }
    const auto flags = pendingFlags_.exchange(0, std::memory_order_acquire);
    const auto variationWord = pendingVariation_.exchange(0, std::memory_order_acquire);
    const bool variationQueued = variationWord >= 1U && variationWord <= 4U;
    if (variationQueued) {
        variation_ = static_cast<std::uint8_t>(variationWord - 1U);
    }
    if (section_ == RhythmSection::Intro || section_ == RhythmSection::Fill || variationQueued) {
        section_ = static_cast<RhythmSection>(static_cast<std::uint8_t>(RhythmSection::VariationA) + variation_);
    }
    // The variation is retained as the return target even when a fill is
    // queued in the same boundary transaction. Ending wins over stop/fill.
    if ((flags & EndingPending) != 0U) {
        section_ = RhythmSection::Ending;
    } else if ((flags & StopPending) != 0U) {
        playing_ = false;
        section_ = RhythmSection::Stopped;
        stagedCount_ = 0;
        stagedCursor_ = 0;
        return true;
    } else if ((flags & FillPending) != 0U) {
        section_ = RhythmSection::Fill;
    }

    barOriginFrame_ = barStartFrame;
    barOriginExactFrame_ = nextBarExactFrame_;
    applyPendingTempo();
    const auto ticksPerBar = static_cast<std::uint64_t>(pattern_->numerator) *
                             4U * kRhythmTicksPerQuarter / pattern_->denominator;
    nextBarExactFrame_ = barOriginExactFrame_ + static_cast<double>(ticksPerBar) * framesPerTick_;
    nextBarFrame_ = absoluteFrameAt(nextBarExactFrame_);
    if (nextBarFrame_ == std::numeric_limits<std::uint64_t>::max()) return false;
    return loadSectionEvents(barOriginFrame_);
}

bool RhythmRenderer::loadSectionEvents(std::uint64_t barStartFrame) noexcept {
    RhythmEventList list{};
    if (section_ == RhythmSection::Intro) {
        list = pattern_->intro;
    } else if (section_ == RhythmSection::Fill) {
        list = pattern_->fill;
    } else if (section_ == RhythmSection::Ending) {
        list = pattern_->ending;
    } else if (isVariation(section_)) {
        list = pattern_->variations[variation_];
    } else {
        stagedCount_ = stagedCursor_ = 0;
        return true;
    }
    if (!list.events || list.count == 0 || list.count > kMaxEventsPerSection) return false;
    const double quarterFrames = static_cast<double>(spec_.sampleRate) * 60.0 / bpm_;
    const double swingFrames = std::round(static_cast<double>(pattern_->swingAmount) * quarterFrames / 3.0);
    if (absoluteFrameAt(barOriginExactFrame_) != barStartFrame) return false;
    stagedCount_ = 0;
    stagedCursor_ = 0;
    for (std::uint32_t i = 0; i < list.count; ++i) {
        const auto& event = list.events[i];
        double exactFrame = barOriginExactFrame_ + static_cast<double>(event.tick) * framesPerTick_;
        if (event.swingable && pattern_->swingAmount > 0.0f) exactFrame += swingFrames;
        const auto eventFrame = absoluteFrameAt(exactFrame);
        if (eventFrame == std::numeric_limits<std::uint64_t>::max()) return false;
        std::uint32_t durationFrames = 0;
        if (event.instrument == RhythmInstrument::BrushSweep) {
            const auto requestedDuration = frameForTicks(event.durationTicks);
            const auto profileDuration = static_cast<std::uint64_t>(std::round(
                static_cast<double>(kit_.brushSweepSeconds) * spec_.sampleRate));
            const auto boundedDuration = std::min(requestedDuration, profileDuration);
            if (boundedDuration == 0 || boundedDuration > std::numeric_limits<std::uint32_t>::max()) return false;
            durationFrames = static_cast<std::uint32_t>(boundedDuration);
        }
        StagedEvent staged{eventFrame, event.instrument, event.velocity, durationFrames};
        std::uint32_t insertion = stagedCount_;
        while (insertion > 0 && stagedEvents_[insertion - 1U].frame > staged.frame) {
            stagedEvents_[insertion] = stagedEvents_[insertion - 1U];
            --insertion;
        }
        stagedEvents_[insertion] = staged;
        ++stagedCount_;
    }
    return true;
}

void RhythmRenderer::trigger(const StagedEvent& event, std::uint64_t absoluteFrame) noexcept {
    const float velocity = static_cast<float>(event.velocity) / 127.0f;
    const auto seed = eventSeed(kitIndex_, absoluteFrame, event.instrument, triggeredEvents_);
    bool triggered = false;
    switch (event.instrument) {
    case RhythmInstrument::Kick: {
        auto parameters = kit_.kick;
        parameters.amplitude = scaled(parameters.amplitude, velocity);
        triggered = voices_.triggerKick(parameters);
        break;
    }
    case RhythmInstrument::Snare:
    case RhythmInstrument::Clap: {
        auto parameters = kit_.snare;
        parameters.amplitude = scaled(parameters.amplitude, velocity *
            (event.instrument == RhythmInstrument::Clap ? 0.84f : 1.0f));
        parameters.noiseLevel = std::clamp(parameters.noiseLevel *
            (event.instrument == RhythmInstrument::Clap ? 1.12f : 1.0f), 0.0f, 1.0f);
        parameters.seed = seed;
        triggered = voices_.triggerSnare(parameters);
        break;
    }
    case RhythmInstrument::ClosedHat:
    case RhythmInstrument::OpenHat:
    case RhythmInstrument::Ride:
    case RhythmInstrument::Shaker: {
        auto parameters = event.instrument == RhythmInstrument::OpenHat ? kit_.openHat : kit_.closedHat;
        if (event.instrument == RhythmInstrument::Ride) {
            parameters.baseFrequencyHz *= 0.72f;
            parameters.decaySeconds = std::min(0.7f, parameters.decaySeconds * 2.4f);
            parameters.amplitude *= 0.8f;
        } else if (event.instrument == RhythmInstrument::Shaker) {
            parameters.baseFrequencyHz *= 1.18f;
            parameters.decaySeconds = std::min(parameters.decaySeconds, 0.13f);
            parameters.noiseLevel = std::min(0.95f, parameters.noiseLevel * 1.25f);
            parameters.amplitude *= 0.70f;
        }
        parameters.amplitude = scaled(parameters.amplitude, velocity);
        parameters.seed = seed;
        triggered = voices_.triggerHiHat(parameters);
        break;
    }
    case RhythmInstrument::TomLow:
    case RhythmInstrument::TomHigh:
    case RhythmInstrument::Rim:
    case RhythmInstrument::CongaLow:
    case RhythmInstrument::CongaHigh: {
        auto parameters = kit_.modal;
        float ratio = 1.0f;
        if (event.instrument == RhythmInstrument::TomLow) ratio = 0.78f;
        if (event.instrument == RhythmInstrument::TomHigh) ratio = 1.55f;
        if (event.instrument == RhythmInstrument::Rim) ratio = 3.2f;
        if (event.instrument == RhythmInstrument::CongaLow) ratio = 0.92f;
        if (event.instrument == RhythmInstrument::CongaHigh) ratio = 1.28f;
        parameters.fundamentalHz *= ratio;
        parameters.amplitude = scaled(parameters.amplitude, velocity);
        parameters.seed = seed;
        triggered = voices_.triggerModal(parameters);
        break;
    }
    case RhythmInstrument::BrushSweep:
        triggerBrushSweep(event, absoluteFrame);
        triggered = true;
        break;
    case RhythmInstrument::Count:
    default:
        break;
    }
    if (triggered) {
        ++triggeredEvents_;
        lastTriggeredFrame_ = absoluteFrame;
    }
}

void RhythmRenderer::triggerBrushSweep(const StagedEvent& event,
                                      std::uint64_t absoluteFrame) noexcept {
    if (event.durationFrames == 0) return;
    std::size_t selected = 0;
    for (std::size_t i = 0; i < brushSweepVoices_.size(); ++i) {
        if (!brushSweepVoices_[i].active) {
            selected = i;
            break;
        }
        if (brushSweepVoices_[i].envelope < brushSweepVoices_[selected].envelope) selected = i;
    }
    auto& voice = brushSweepVoices_[selected];
    const auto seed = eventSeed(kitIndex_, absoluteFrame, event.instrument, triggeredEvents_);
    voice.randomLeft = seed ? seed : 1U;
    voice.randomRight = seed ^ 0xa0761d6478bd642fULL;
    if (voice.randomRight == 0) voice.randomRight = 2U;
    voice.remaining = event.durationFrames;
    voice.amplitude = kit_.brushSweepAmplitude *
                      (static_cast<float>(event.velocity) / 127.0f) * 0.35f;
    voice.envelope = 1.0f;
    voice.envelopeStep = static_cast<float>(std::exp(-7.0 / event.durationFrames));
    const double cutoff = std::clamp(static_cast<double>(kit_.brushSweepHighpassHz),
                                     300.0, static_cast<double>(spec_.sampleRate) * 0.45);
    voice.lowCoefficient = static_cast<float>(std::exp(-2.0 * 3.14159265358979323846 *
                                                       cutoff / spec_.sampleRate));
    voice.lowLeft = 0.0f;
    voice.lowRight = 0.0f;
    voice.active = true;
}

StereoFrame RhythmRenderer::processBrushSweeps() noexcept {
    StereoFrame output{};
    const auto randomBipolar = [](std::uint64_t& state) noexcept {
        state ^= state >> 12U;
        state ^= state << 25U;
        state ^= state >> 27U;
        const auto bits = state * 0x2545f4914f6cdd1dULL;
        const auto centered = static_cast<std::int32_t>(bits >> 40U) - 0x7fffff;
        return static_cast<float>(centered) / 8388608.0f;
    };
    for (auto& voice : brushSweepVoices_) {
        if (!voice.active) continue;
        const float whiteLeft = randomBipolar(voice.randomLeft);
        const float whiteRight = randomBipolar(voice.randomRight);
        voice.lowLeft = voice.lowCoefficient * voice.lowLeft +
                        (1.0f - voice.lowCoefficient) * whiteLeft;
        voice.lowRight = voice.lowCoefficient * voice.lowRight +
                         (1.0f - voice.lowCoefficient) * whiteRight;
        output.left += (whiteLeft - voice.lowLeft) * voice.amplitude * voice.envelope;
        output.right += (whiteRight - voice.lowRight) * voice.amplitude * voice.envelope;
        voice.envelope *= voice.envelopeStep;
        if (voice.remaining > 0) --voice.remaining;
        if (voice.remaining == 0 || voice.envelope < 1.0e-5f) voice.active = false;
    }
    return output;
}

StereoFrame RhythmRenderer::processVoice() noexcept {
    auto output = voices_.processSample();
    const auto brush = processBrushSweeps();
    output.left += brush.left;
    output.right += brush.right;
    output.left = std::isfinite(output.left) ? output.left : 0.0f;
    output.right = std::isfinite(output.right) ? output.right : 0.0f;
    return output;
}

bool RhythmRenderer::processBlock(std::uint64_t blockStartFrame, float* outputLeft,
                                  float* outputRight, std::uint32_t frames) noexcept {
    if (!prepared_ || !outputLeft || !outputRight || frames > spec_.maxBlockFrames ||
        blockStartFrame > std::numeric_limits<std::uint64_t>::max() - frames) return false;
    if (hasExpectedBlockFrame_ && blockStartFrame != expectedBlockFrame_) {
        std::fill_n(outputLeft, frames, 0.0f);
        std::fill_n(outputRight, frames, 0.0f);
        reset();
        return false;
    }
    for (std::uint32_t i = 0; i < frames; ++i) {
        const auto frame = blockStartFrame + i;
        if (startRequested_) {
            startRequested_ = false;
            playbackArmed_ = true;
        }
        if (playbackArmed_ && frame >= requestedStartFrame_) {
            if (!beginPlayback(frame)) {
                playing_ = false;
                playbackArmed_ = false;
                section_ = RhythmSection::Stopped;
            }
        }
        std::uint32_t barsCaughtUp = 0;
        while (playing_ && frame >= nextBarFrame_ && barsCaughtUp < 64U) {
            const auto transitionFrame = nextBarFrame_;
            if (!beginNextBar(transitionFrame)) {
                playing_ = false;
                section_ = RhythmSection::Stopped;
                stagedCount_ = 0;
                stagedCursor_ = 0;
                break;
            }
            ++barsCaughtUp;
        }
        if (playing_ && barsCaughtUp == 64U && frame >= nextBarFrame_) {
            // A discontinuous host timeline cannot cause an unbounded catch-up
            // loop on the realtime thread. End cleanly and retain the voice tail.
            playing_ = false;
            section_ = RhythmSection::Stopped;
            stagedCount_ = 0;
            stagedCursor_ = 0;
        }
        while (playing_ && stagedCursor_ < stagedCount_ &&
               stagedEvents_[stagedCursor_].frame <= frame) {
            trigger(stagedEvents_[stagedCursor_], frame);
            ++stagedCursor_;
        }
        const auto voice = processVoice();
        outputLeft[i] = voice.left;
        outputRight[i] = voice.right;
    }
    if (frames > 0) {
        expectedBlockFrame_ = blockStartFrame + frames;
        hasExpectedBlockFrame_ = true;
    }
    return true;
}

std::size_t RhythmRenderer::requiredMemoryBytes() noexcept {
    return sizeof(RhythmRenderer);
}

} // namespace webrc::dsp
