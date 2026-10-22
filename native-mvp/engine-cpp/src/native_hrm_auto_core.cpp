#include "native_hrm_auto_core.hpp"

#include <algorithm>
#include <cmath>
#include <limits>

namespace webrc::native {

namespace {

constexpr double kYinThreshold = 0.16;
constexpr double kMinimumVoicedRms = 0.003;
constexpr float kMaximumVoiceShift = 24.0f;
constexpr std::array<int, 7U> kMajor{{0, 2, 4, 5, 7, 9, 11}};
constexpr std::array<int, 7U> kNaturalMinor{{0, 2, 3, 5, 7, 8, 10}};
constexpr std::array<int, 7U> kHarmonicMinor{{0, 2, 3, 5, 7, 8, 11}};
constexpr std::array<int, 7U> kDorian{{0, 2, 3, 5, 7, 9, 10}};
constexpr std::array<int, 7U> kMixolydian{{0, 2, 4, 5, 7, 9, 10}};

[[nodiscard]] bool validScale(NativeHrmAutoCore::Scale scale) noexcept {
    return static_cast<unsigned int>(scale) <= static_cast<unsigned int>(NativeHrmAutoCore::Scale::Mixolydian);
}

[[nodiscard]] unsigned int floorMod12(int value) noexcept {
    const int remainder = value % 12;
    return static_cast<unsigned int>(remainder < 0 ? remainder + 12 : remainder);
}

[[nodiscard]] int floorDiv12(int value) noexcept {
    if (value >= 0) return value / 12;
    return -((-value + 11) / 12);
}

} // namespace

bool NativeHrmAutoCore::PitchTracker::configure(unsigned int detectorRate) noexcept {
    if (detectorRate < 4000U || detectorRate > 12000U) return false;
    const unsigned int minLag = std::max(2U, static_cast<unsigned int>(std::floor(
        static_cast<double>(detectorRate) / 1000.0)));
    const unsigned int maxLag = static_cast<unsigned int>(std::ceil(
        static_cast<double>(detectorRate) / 65.0));
    if (maxLag < minLag || maxLag > kDetectorMaximumLag) return false;
    const unsigned int frame = std::max(64U, maxLag * 3U);
    if (frame + 1U > kDetectorRingCapacity) return false;

    sampleRate = detectorRate;
    minimumLag = minLag;
    maximumLag = maxLag;
    frameSamples = frame;
    analysisWindowSamples = frame - maxLag;
    hopSamples = std::max(1U, static_cast<unsigned int>(std::lround(
        static_cast<double>(detectorRate) * 0.005)));
    if (hopSamples > frame) return false;
    reset();
    return true;
}

void NativeHrmAutoCore::PitchTracker::reset() noexcept {
    ring.fill(0.0f);
    differences.fill(0.0);
    normalizedDifferences.fill(1.0);
    writeIndex = 0U;
    sampleCount = 0U;
    nextAnalysisSample = frameSamples;
    goodFrames = 0U;
    badFrames = 0U;
    frequencyHz = 0.0f;
    confidence = 0.0f;
    smoothedLogFrequency = 0.0;
    voiced = false;
}

void NativeHrmAutoCore::PitchTracker::pushSample(float sample) noexcept {
    ring[writeIndex] = std::isfinite(sample) ? sample : 0.0f;
    writeIndex = (writeIndex + 1U) & kDetectorRingMask;
    ++sampleCount;
    if (sampleCount < nextAnalysisSample) return;
    analyzeFrame();
    nextAnalysisSample += hopSamples;
}

void NativeHrmAutoCore::PitchTracker::analyzeFrame() noexcept {
    const unsigned int frameStart = (writeIndex + kDetectorRingCapacity - frameSamples) & kDetectorRingMask;
    double energy = 0.0;
    for (unsigned int i = 0U; i < frameSamples; ++i) {
        const double sample = ring[(frameStart + i) & kDetectorRingMask];
        energy += sample * sample;
    }
    const double rms = std::sqrt(energy / static_cast<double>(frameSamples));

    differences[0] = 0.0;
    for (unsigned int lag = 1U; lag <= maximumLag; ++lag) {
        double sum = 0.0;
        for (unsigned int i = 0U; i < analysisWindowSamples; ++i) {
            const double delta = static_cast<double>(ring[(frameStart + i) & kDetectorRingMask]) -
                static_cast<double>(ring[(frameStart + i + lag) & kDetectorRingMask]);
            sum += delta * delta;
        }
        differences[lag] = sum;
    }

    double cumulativeDifference = 0.0;
    for (unsigned int lag = 1U; lag <= maximumLag; ++lag) {
        const double difference = differences[lag];
        cumulativeDifference += difference;
        normalizedDifferences[lag] = cumulativeDifference > 1.0e-15
            ? difference * static_cast<double>(lag) / cumulativeDifference
            : 1.0;
    }

    unsigned int bestLag = 0U;
    double bestValue = std::numeric_limits<double>::infinity();
    const double threshold = voiced ? 0.22 : kYinThreshold;
    for (unsigned int lag = minimumLag; lag <= maximumLag; ++lag) {
        const double value = normalizedDifferences[lag];
        if (value < bestValue) {
            bestValue = value;
            bestLag = lag;
        }
        if (value < threshold && (lag == maximumLag || value <= normalizedDifferences[lag + 1U])) {
            bestLag = lag;
            while (bestLag < maximumLag &&
                   normalizedDifferences[bestLag + 1U] < normalizedDifferences[bestLag]) {
                ++bestLag;
            }
            bestValue = normalizedDifferences[bestLag];
            break;
        }
    }

    confidence = std::isfinite(bestValue)
        ? static_cast<float>(std::clamp(1.0 - bestValue, 0.0, 1.0))
        : 0.0f;
    const bool candidate = rms >= kMinimumVoicedRms && bestLag > 0U && bestValue < threshold;
    if (candidate) {
        ++goodFrames;
        badFrames = 0U;
        double refinedLag = static_cast<double>(bestLag);
        if (bestLag > minimumLag && bestLag < maximumLag) {
            const double left = normalizedDifferences[bestLag - 1U];
            const double center = normalizedDifferences[bestLag];
            const double right = normalizedDifferences[bestLag + 1U];
            const double denominator = left - 2.0 * center + right;
            if (std::fabs(denominator) > 1.0e-12) {
                refinedLag += std::clamp(0.5 * (left - right) / denominator, -0.5, 0.5);
            }
        }
        const float measuredHz = static_cast<float>(static_cast<double>(sampleRate) / refinedLag);
        const double measuredLog = std::log(static_cast<double>(measuredHz));
        if (goodFrames == 1U || frequencyHz <= 0.0f) {
            smoothedLogFrequency = measuredLog;
        } else {
            smoothedLogFrequency += (measuredLog - smoothedLogFrequency) * 0.35;
        }
        frequencyHz = static_cast<float>(std::exp(smoothedLogFrequency));
        if (goodFrames >= 2U) voiced = true;
    } else {
        goodFrames = 0U;
        ++badFrames;
        if (badFrames >= 2U) voiced = false;
    }
}

bool NativeHrmAutoCore::validConfig(const Config& config) noexcept {
    return config.sampleRate >= kMinimumSampleRate && config.sampleRate <= kMaximumSampleRate &&
        config.channels > 0U && config.channels <= kMaximumChannels && config.key < 12U &&
        validScale(config.scale) && config.midiChannel >= 1U && config.midiChannel <= 16U &&
        std::isfinite(config.mixPercent) && config.mixPercent >= 0.0f && config.mixPercent <= 100.0f;
}

int NativeHrmAutoCore::pitchClass(int midiNote) noexcept {
    const int remainder = midiNote % 12;
    return remainder < 0 ? remainder + 12 : remainder;
}

const std::array<int, 7U>& NativeHrmAutoCore::scaleOffsets(Scale scale) noexcept {
    switch (scale) {
    case Scale::NaturalMinor: return kNaturalMinor;
    case Scale::HarmonicMinor: return kHarmonicMinor;
    case Scale::Dorian: return kDorian;
    case Scale::Mixolydian: return kMixolydian;
    case Scale::Major:
    default: return kMajor;
    }
}

int NativeHrmAutoCore::snapMidiToScale(int midiNote) const noexcept {
    const auto& offsets = scaleOffsets(config_.scale);
    const int key = static_cast<int>(config_.key);
    int best = std::clamp(midiNote, 0, 127);
    int bestDistance = 128;
    for (int candidate = std::max(0, midiNote - 12); candidate <= std::min(127, midiNote + 12); ++candidate) {
        const unsigned int relativePitchClass = floorMod12(candidate - key);
        bool allowed = false;
        for (const int offset : offsets) {
            if (relativePitchClass == static_cast<unsigned int>(offset)) {
                allowed = true;
                break;
            }
        }
        if (!allowed) continue;
        const int distance = std::abs(candidate - midiNote);
        if (distance < bestDistance || (distance == bestDistance && candidate < best)) {
            best = candidate;
            bestDistance = distance;
        }
    }
    return best;
}

int NativeHrmAutoCore::diatonicInterval(int snappedRoot, unsigned int degreeOffset) const noexcept {
    const auto& offsets = scaleOffsets(config_.scale);
    const int relative = snappedRoot - static_cast<int>(config_.key);
    const int octave = floorDiv12(relative);
    const unsigned int withinOctave = floorMod12(relative);
    unsigned int rootDegree = 0U;
    for (unsigned int i = 0U; i < offsets.size(); ++i) {
        if (withinOctave == static_cast<unsigned int>(offsets[i])) {
            rootDegree = i;
            break;
        }
    }
    const unsigned int absoluteDegree = rootDegree + degreeOffset;
    const int target = static_cast<int>(config_.key) +
        (octave + static_cast<int>(absoluteDegree / static_cast<unsigned int>(offsets.size()))) * 12 +
        offsets[absoluteDegree % static_cast<unsigned int>(offsets.size())];
    return std::clamp(target, 0, 127);
}

int NativeHrmAutoCore::nearestOctave(int midiNote, float sourceMidi) const noexcept {
    int best = std::clamp(midiNote, 0, 127);
    float bestDistance = std::fabs(static_cast<float>(best) - sourceMidi);
    for (int octave = -10; octave <= 10; ++octave) {
        const int candidate = midiNote + octave * 12;
        if (candidate < 0 || candidate > 127) continue;
        const float distance = std::fabs(static_cast<float>(candidate) - sourceMidi);
        if (distance < bestDistance || (distance == bestDistance && candidate < best)) {
            best = candidate;
            bestDistance = distance;
        }
    }
    return best;
}

unsigned int NativeHrmAutoCore::collectTargets(std::array<int, 2U>& targets) const noexcept {
    targets = {{-1, -1}};
    if (heldNoteCount_ == 0U) return 0U;
    if (heldNoteCount_ == 1U) {
        for (unsigned int note = 0U; note < kMidiNoteCount; ++note) {
            if (heldNoteRefs_[note] == 0U) continue;
            const int snappedRoot = snapMidiToScale(static_cast<int>(note));
            targets[0] = diatonicInterval(snappedRoot, 2U);
            targets[1] = diatonicInterval(snappedRoot, 4U);
            return 2U;
        }
        return 0U;
    }

    unsigned int count = 0U;
    for (unsigned int note = 0U; note < kMidiNoteCount && count < targets.size(); ++note) {
        if (heldNoteRefs_[note] == 0U) continue;
        targets[count++] = snapMidiToScale(static_cast<int>(note));
    }
    return count;
}

bool NativeHrmAutoCore::prepare(const Config& config) noexcept {
    prepared_ = false;
    if (!validConfig(config)) return false;
    if (!voiceA_.prepareForFx(config.sampleRate, 0.0f) || !voiceB_.prepareForFx(config.sampleRate, 0.0f)) {
        return false;
    }

    const unsigned int decimation = std::max(1U, static_cast<unsigned int>(std::ceil(
        static_cast<double>(config.sampleRate) / 12000.0)));
    const unsigned int detectorRate = static_cast<unsigned int>(std::lround(
        static_cast<double>(config.sampleRate) / static_cast<double>(decimation)));
    if (!tracker_.configure(detectorRate)) return false;

    config_ = config;
    detectorDecimation_ = decimation;
    prepared_ = true;
    reset();
    return true;
}

bool NativeHrmAutoCore::configure(const Config& config) noexcept {
    if (!validConfig(config)) return false;
    if (!prepared_ || config.sampleRate != config_.sampleRate || config.channels != config_.channels) {
        return prepare(config);
    }

    const bool channelChanged = config.midiChannel != config_.midiChannel;
    config_ = config;
    if (channelChanged) {
        heldNoteRefs_.fill(0U);
        heldNoteCount_ = 0U;
        clearEventQueue();
        hasLastEnqueuedFrame_ = false;
        lastEnqueuedFrame_ = 0U;
    }
    updateVoiceTargets();
    return true;
}

void NativeHrmAutoCore::disableOfficialControls() noexcept {
    officialActive_ = false;
    if (prepared_) {
        (void)voiceA_.setFormantSemitones(0.0f, false);
        (void)voiceA_.setFormantBaseHz(0.0f);
    }
}

bool NativeHrmAutoCore::setOfficialParameter(std::string_view id, float value, bool manual) noexcept {
    if (!std::isfinite(value)) return false;
    const bool discrete = id == "official_voice" || id == "official_key" || id == "official_hrm_mode";
    if (discrete && std::floor(value) != value) return false;
    if (id == "official_voice") { if (value < 0.0f || value > (manual ? 10.0f : 6.0f)) return false; }
    else if (id == "official_formant" || id == "official_pan") { if (value < -50.0f || value > 50.0f) return false; }
    else if (id == "official_key") { if (value < 0.0f || value > 11.0f) return false; }
    else if (id == "official_hrm_mode" && !manual) { if (value < 0.0f || value > 1.0f) return false; }
    else if (id == "official_d_level" || id == "official_hrm_level") { if (value < 0.0f || value > 100.0f) return false; }
    else return false;
    if (!officialActive_ || officialManual_ != manual) {
        officialVoice_ = manual ? 6U : 4U;
        officialManual_ = manual;
    }
    officialActive_ = true;
    if (id == "official_voice") officialVoice_ = static_cast<unsigned int>(value);
    else if (id == "official_key") officialKey_ = static_cast<unsigned int>(value);
    else if (id == "official_hrm_mode") officialMode_ = static_cast<unsigned int>(value);
    else if (id == "official_formant") officialFormant_ = value * 12.0f / 50.0f;
    else if (id == "official_pan") officialPan_.setTarget(value / 50.0f, 64U);
    else if (id == "official_d_level") officialDirect_.setTarget(value * 0.01f, 64U);
    else if (id == "official_hrm_level") officialHarmony_.setTarget(value * 0.01f, 64U);
    if (prepared_) updateVoiceTargets();
    return true;
}

float NativeHrmAutoCore::officialShift(float sourceMidi) const noexcept {
    if (officialVoice_ == 0U) return -12.0f;
    if (officialVoice_ == 1U) return 12.0f;
    if (officialVoice_ == (officialManual_ ? 10U : 6U)) return 0.08f;
    constexpr std::array<int, 7U> major{{0, 2, 4, 5, 7, 9, 11}};
    if (officialManual_) {
        // Snap the source to the selected major scale, then move by diatonic
        // degrees. Relative-minor key labels share these pitch classes.
        int nearest = 0;
        float best = 1.0e9f;
        for (int degree = -21; degree < 98; ++degree) {
            const int octave = static_cast<int>(std::floor(static_cast<double>(degree) / 7.0));
            const int index = degree - octave * 7;
            const int note = static_cast<int>(officialKey_) + octave * 12 + major[static_cast<std::size_t>(index)];
            const float distance = std::fabs(static_cast<float>(note) - sourceMidi);
            if (distance < best) { best = distance; nearest = degree; }
        }
        constexpr std::array<int, 11U> degrees{{-7, 7, -5, -4, -3, -2, 2, 3, 4, 5, 0}};
        const int targetDegree = nearest + degrees[officialVoice_];
        const int octave = static_cast<int>(std::floor(static_cast<double>(targetDegree) / 7.0));
        const int index = targetDegree - octave * 7;
        const int note = static_cast<int>(officialKey_) + octave * 12 + major[static_cast<std::size_t>(index)];
        return std::clamp(static_cast<float>(note) - sourceMidi, -24.0f, 24.0f);
    }
    std::array<bool, 12U> allowed{};
    std::array<bool, 12U> keyAllowed{};
    for (int interval : major) keyAllowed[(officialKey_ + static_cast<unsigned int>(interval)) % 12U] = true;
    bool any = false;
    for (unsigned int note = 0U; note < kMidiNoteCount; ++note) {
        if (heldNoteRefs_[note] == 0U) continue;
        const unsigned int pc = note % 12U;
        if (officialMode_ == 1U || keyAllowed[pc]) { allowed[pc] = true; any = true; }
    }
    if (!any && officialMode_ == 0U) allowed = keyAllowed;
    const int direction = officialVoice_ <= 3U ? -1 : 1;
    unsigned int remaining = (officialVoice_ == 2U || officialVoice_ == 5U) ? 2U : 1U;
    int note = direction < 0 ? static_cast<int>(std::ceil(sourceMidi - 0.03f)) - 1
                             : static_cast<int>(std::floor(sourceMidi + 0.03f)) + 1;
    for (int step = 0; step < 36; ++step, note += direction) {
        if (!allowed[static_cast<std::size_t>(pitchClass(note))]) continue;
        if (--remaining == 0U) return std::clamp(static_cast<float>(note) - sourceMidi, -24.0f, 24.0f);
    }
    return 0.0f;
}

bool NativeHrmAutoCore::enqueueMidi(const MidiEvent& event) noexcept {
    const auto reject = [this]() noexcept {
        rejectedEventCount_.fetch_add(1U, std::memory_order_relaxed);
        return false;
    };
    if (!prepared_ || event.data1 > 127U || event.data2 > 127U) return reject();
    const std::uint8_t messageType = static_cast<std::uint8_t>(event.status & 0xf0U);
    if (messageType != 0x80U && messageType != 0x90U) return reject();
    const unsigned int eventChannel = static_cast<unsigned int>(event.status & 0x0fU) + 1U;
    if (eventChannel != config_.midiChannel) return reject();

    const std::uint64_t current = currentFrame_.load(std::memory_order_acquire);
    const std::uint64_t floor = enqueueFloorFrame_.load(std::memory_order_acquire);
    if (event.frame < current || event.frame < floor ||
        (hasLastEnqueuedFrame_ && event.frame < lastEnqueuedFrame_)) {
        return reject();
    }

    const std::uint32_t head = queueHead_.load(std::memory_order_relaxed);
    const std::uint32_t tail = queueTail_.load(std::memory_order_acquire);
    if (head - tail >= kMidiQueueCapacity) {
        overflowCount_.fetch_add(1U, std::memory_order_relaxed);
        return false;
    }
    eventQueue_[head & (kMidiQueueCapacity - 1U)] = event;
    queueHead_.store(head + 1U, std::memory_order_release);
    lastEnqueuedFrame_ = event.frame;
    hasLastEnqueuedFrame_ = true;
    return true;
}

bool NativeHrmAutoCore::synchronizeFrame(std::uint64_t absoluteFrame) noexcept {
    if (!prepared_) return false;
    const std::uint64_t current = currentFrame_.load(std::memory_order_acquire);
    if (absoluteFrame < current) return false;
    if (absoluteFrame == current) return true;

    const std::uint64_t oldFloor = enqueueFloorFrame_.load(std::memory_order_acquire);
    enqueueFloorFrame_.store(std::max(oldFloor, absoluteFrame), std::memory_order_release);
    MidiEvent event{};
    while (peekEvent(event) && event.frame < absoluteFrame) {
        (void)popEvent(event);
        handleMidi(event);
        lateEventCount_.fetch_add(1U, std::memory_order_relaxed);
    }
    currentFrame_.store(absoluteFrame, std::memory_order_release);
    return true;
}

void NativeHrmAutoCore::clearEventQueue() noexcept {
    const std::uint32_t head = queueHead_.load(std::memory_order_relaxed);
    queueTail_.store(head, std::memory_order_release);
    enqueueFloorFrame_.store(currentFrame_.load(std::memory_order_relaxed), std::memory_order_release);
}

void NativeHrmAutoCore::reset() noexcept {
    if (prepared_) {
        voiceA_.reset();
        voiceB_.reset();
        (void)voiceA_.setSemitones(0.0f);
        (void)voiceB_.setSemitones(0.0f);
    }
    tracker_.reset();
    dryRing_.fill(0.0f);
    heldNoteRefs_.fill(0U);
    heldNoteCount_ = 0U;
    decimatorCount_ = 0U;
    decimatorSum_ = 0.0;
    voiceCount_ = 0U;
    targetMidiNotes_ = {{-1, -1}};
    targetSemitones_ = {{0.0f, 0.0f}};
    currentFrame_.store(0U, std::memory_order_release);
    enqueueFloorFrame_.store(0U, std::memory_order_release);
    queueHead_.store(0U, std::memory_order_release);
    queueTail_.store(0U, std::memory_order_release);
    lastEnqueuedFrame_ = 0U;
    lateEventCount_.store(0U, std::memory_order_release);
    overflowCount_.store(0U, std::memory_order_release);
    rejectedEventCount_.store(0U, std::memory_order_release);
    hasLastEnqueuedFrame_ = false;
}

float NativeHrmAutoCore::sourceMidiNote() const noexcept {
    if (!tracker_.voiced || tracker_.frequencyHz <= 0.0f) return -1.0f;
    return static_cast<float>(69.0 + 12.0 * std::log2(static_cast<double>(tracker_.frequencyHz) / 440.0));
}

bool NativeHrmAutoCore::peekEvent(MidiEvent& event) const noexcept {
    const std::uint32_t tail = queueTail_.load(std::memory_order_relaxed);
    const std::uint32_t head = queueHead_.load(std::memory_order_acquire);
    if (tail == head) return false;
    event = eventQueue_[tail & (kMidiQueueCapacity - 1U)];
    return true;
}

bool NativeHrmAutoCore::popEvent(MidiEvent& event) noexcept {
    if (!peekEvent(event)) return false;
    const std::uint32_t tail = queueTail_.load(std::memory_order_relaxed);
    queueTail_.store(tail + 1U, std::memory_order_release);
    return true;
}

void NativeHrmAutoCore::handleMidi(const MidiEvent& event) noexcept {
    const std::uint8_t messageType = static_cast<std::uint8_t>(event.status & 0xf0U);
    const unsigned int note = event.data1;
    const bool noteOn = messageType == 0x90U && event.data2 != 0U;
    auto& refs = heldNoteRefs_[note];
    if (noteOn) {
        if (refs == 0U) ++heldNoteCount_;
        if (refs < std::numeric_limits<std::uint8_t>::max()) ++refs;
    } else if (refs > 0U) {
        --refs;
        if (refs == 0U) --heldNoteCount_;
    }
}

void NativeHrmAutoCore::updateVoiceTargets() noexcept {
    std::array<int, 2U> targets{{-1, -1}};
    const float sourceMidi = sourceMidiNote();
    if (officialActive_) {
        voiceCount_ = tracker_.voiced && sourceMidi >= 0.0f && (officialManual_ || heldNoteCount_ > 0U) ? 1U : 0U;
        const float shift = voiceCount_ > 0U ? officialShift(sourceMidi) : 0.0f;
        targetMidiNotes_ = {{voiceCount_ > 0U ? static_cast<int>(std::lround(sourceMidi + shift)) : -1, -1}};
        targetSemitones_ = {{shift, 0.0f}};
        if (std::fabs(voiceA_.semitones() - shift) > 0.0001f) (void)voiceA_.setSemitones(shift);
        (void)voiceA_.setFormantSemitones(officialFormant_, true);
        if (tracker_.voiced) (void)voiceA_.setFormantBaseHz(tracker_.frequencyHz);
        return;
    }
    unsigned int candidateCount = 0U;
    if (tracker_.voiced && heldNoteCount_ > 0U && sourceMidi >= 0.0f) {
        candidateCount = collectTargets(targets);
    }

    targetMidiNotes_ = {{-1, -1}};
    targetSemitones_ = {{0.0f, 0.0f}};
    unsigned int newVoiceCount = candidateCount;
    for (unsigned int candidate = 0U; candidate < candidateCount; ++candidate) {
        const int selectedNote = nearestOctave(targets[candidate], sourceMidi);
        const float shift = std::clamp(static_cast<float>(selectedNote) - sourceMidi,
                                       -kMaximumVoiceShift, kMaximumVoiceShift);
        targetMidiNotes_[candidate] = selectedNote;
        targetSemitones_[candidate] = shift;
    }
    voiceCount_ = newVoiceCount;

    const float shiftA = newVoiceCount > 0U ? targetSemitones_[0] : 0.0f;
    const float shiftB = newVoiceCount > 1U ? targetSemitones_[1] : 0.0f;
    if (std::fabs(voiceA_.semitones() - shiftA) > 0.0001f) (void)voiceA_.setSemitones(shiftA);
    if (std::fabs(voiceB_.semitones() - shiftB) > 0.0001f) (void)voiceB_.setSemitones(shiftB);
}

bool NativeHrmAutoCore::processSegment(float* interleaved, unsigned int frames,
                                       std::uint64_t segmentStart) noexcept {
    const unsigned int channels = config_.channels;
    for (unsigned int frame = 0U; frame < frames; ++frame) {
        const std::size_t sourceOffset = static_cast<std::size_t>(frame) * channels;
        const std::size_t ringOffset = static_cast<std::size_t>((segmentStart + frame) & kDryRingMask) * channels;
        double mono = 0.0;
        for (unsigned int channel = 0U; channel < channels; ++channel) {
            float sample = interleaved[sourceOffset + channel];
            if (!std::isfinite(sample)) sample = 0.0f;
            interleaved[sourceOffset + channel] = sample;
            voiceAScratch_[sourceOffset + channel] = sample;
            voiceBScratch_[sourceOffset + channel] = sample;
            dryRing_[ringOffset + channel] = sample;
            mono += static_cast<double>(sample);
        }
        mono /= static_cast<double>(channels);
        decimatorSum_ += mono;
        ++decimatorCount_;
        if (decimatorCount_ >= detectorDecimation_) {
            tracker_.pushSample(static_cast<float>(decimatorSum_ / static_cast<double>(detectorDecimation_)));
            decimatorCount_ = 0U;
            decimatorSum_ = 0.0;
        }
    }

    // The analysis sees the bounded quantum before its delayed audio reaches
    // the output, keeping pitch estimates available without audio-thread waits.
    updateVoiceTargets();
    if (!voiceA_.processInterleaved(voiceAScratch_.data(), frames, channels) ||
        !voiceB_.processInterleaved(voiceBScratch_.data(), frames, channels)) {
        return false;
    }

    const bool wetActive = voiceCount_ > 0U && config_.mixPercent > 0.0f;
    const float mix = wetActive ? config_.mixPercent / 100.0f : 0.0f;
    const unsigned int latency = latencyFrames();
    for (unsigned int frame = 0U; frame < frames; ++frame) {
        const std::uint64_t absoluteFrame = segmentStart + frame;
        const std::size_t destinationOffset = static_cast<std::size_t>(frame) * channels;
        const std::size_t delayedRingOffset = absoluteFrame >= latency
            ? static_cast<std::size_t>((absoluteFrame - latency) & kDryRingMask) * channels
            : 0U;
        const float direct = officialActive_ ? officialDirect_.next() : 1.0f;
        const float harmony = officialActive_ ? officialHarmony_.next() : 1.0f;
        const float pan = officialActive_ ? officialPan_.next() : 0.0f;
        const float angle = (pan + 1.0f) * 0.7853981633974483f;
        const float wetMono = channels == 2U
            ? (voiceAScratch_[destinationOffset] + voiceAScratch_[destinationOffset + 1U]) * 0.5f
            : voiceAScratch_[destinationOffset];
        for (unsigned int channel = 0U; channel < channels; ++channel) {
            const float dry = absoluteFrame >= latency ? dryRing_[delayedRingOffset + channel] : 0.0f;
            if (officialActive_) {
                const float gain = channels == 1U ? 1.0f
                    : 1.4142135623730951f * (channel == 0U ? std::cos(angle) : std::sin(angle));
                const float output = dry * direct + (voiceCount_ > 0U ? wetMono * harmony * gain : 0.0f);
                interleaved[destinationOffset + channel] = std::isfinite(output) ? output : 0.0f;
                continue;
            }
            float output = dry;
            if (wetActive) {
                const float voiceA = std::isfinite(voiceAScratch_[destinationOffset + channel])
                    ? voiceAScratch_[destinationOffset + channel] : 0.0f;
                const float voiceB = voiceCount_ > 1U && std::isfinite(voiceBScratch_[destinationOffset + channel])
                    ? voiceBScratch_[destinationOffset + channel] : 0.0f;
                const float wet = voiceCount_ > 1U ? 0.5f * (voiceA + voiceB) : voiceA;
                output = dry * (1.0f - mix) + wet * mix;
            }
            interleaved[destinationOffset + channel] = std::isfinite(output) ? output : 0.0f;
        }
    }
    return true;
}

bool NativeHrmAutoCore::processInterleaved(float* interleaved, unsigned int frames,
                                           unsigned int channels) noexcept {
    if (!prepared_ || channels != config_.channels || channels == 0U || channels > kMaximumChannels ||
        (frames > 0U && interleaved == nullptr)) {
        return false;
    }
    if (frames == 0U) return true;
    const std::uint64_t start = currentFrame_.load(std::memory_order_acquire);
    if (static_cast<std::uint64_t>(frames) > std::numeric_limits<std::uint64_t>::max() - start) return false;
    const std::uint64_t end = start + static_cast<std::uint64_t>(frames);
    unsigned int processedFrames = 0U;

    while (processedFrames < frames) {
        const std::uint64_t cursor = currentFrame_.load(std::memory_order_relaxed);
        const std::uint64_t remaining = end - cursor;
        const unsigned int quantumFrames = static_cast<unsigned int>(std::min<std::uint64_t>(
            remaining, kMaximumControlQuantumFrames));
        const std::uint64_t quantumEnd = cursor + quantumFrames;
        // Refuse events stamped inside an active quantum; events that were
        // already queued before the callback are still consumed sample-accurately.
        enqueueFloorFrame_.store(quantumEnd, std::memory_order_release);

        MidiEvent event{};
        while (peekEvent(event) && event.frame <= cursor) {
            (void)popEvent(event);
            if (event.frame < cursor) lateEventCount_.fetch_add(1U, std::memory_order_relaxed);
            handleMidi(event);
        }

        std::uint64_t segmentEnd = quantumEnd;
        if (peekEvent(event) && event.frame > cursor && event.frame < segmentEnd) {
            segmentEnd = event.frame;
        }
        const unsigned int segmentFrames = static_cast<unsigned int>(segmentEnd - cursor);
        if (segmentFrames == 0U) continue;
        if (!processSegment(interleaved + static_cast<std::size_t>(processedFrames) * channels,
                            segmentFrames, cursor)) {
            prepared_ = false;
            return false;
        }
        processedFrames += segmentFrames;
        currentFrame_.store(cursor + segmentFrames, std::memory_order_release);
    }

    // A producer may enqueue the next block's first event after this call.
    enqueueFloorFrame_.store(end, std::memory_order_release);
    return true;
}

} // namespace webrc::native
