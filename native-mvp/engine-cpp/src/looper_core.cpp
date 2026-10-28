#include "looper_core.hpp"
#include "dsp_primitives.hpp"

#include <algorithm>
#include <cmath>
#include <limits>
#include <new>
#include <stdexcept>

namespace webrc::native {
std::size_t LooperCore::maximumDurationSecondsForBudget(
    unsigned int sampleRate,
    unsigned int channels,
    std::size_t trackCount,
    std::size_t requestedSeconds,
    std::uint64_t budgetBytes
) noexcept {
    if (sampleRate == 0U || sampleRate > kMaximumSampleRate || trackCount == 0U || requestedSeconds == 0U || budgetBytes == 0U) {
        return 0U;
    }
    const std::size_t boundedChannels = channels == 2U ? 2U : 1U;
    constexpr std::size_t kBytesPerSample = sizeof(float);
    const std::size_t bytesPerSecondPerTrack = static_cast<std::size_t>(sampleRate) * boundedChannels * kBytesPerSample;
    if (trackCount > budgetBytes / bytesPerSecondPerTrack) return 0U;
    const std::size_t secondsUnderBudget = static_cast<std::size_t>(budgetBytes / (bytesPerSecondPerTrack * trackCount));
    return std::min(requestedSeconds, secondsUnderBudget);
}

LooperCore::LooperCore(unsigned int sampleRate, std::size_t maxLoopSeconds, unsigned int channels)
    : sampleRate_(0U),
      maxLoopSeconds_(0U),
      capacityFrames_(0U),
      channels_(1U),
      loopBuffer_(),
      state_(LooperState::Empty),
      monitoringEnabled_(false),
      recordedFrames_(0),
      finalizedFrames_(0),
      playhead_(0),
      loopTransportConfig_(),
      previousLoopTransportConfig_() {
    if (!prepare(sampleRate, maxLoopSeconds, channels)) throw std::bad_alloc();
}

bool LooperCore::prepare(unsigned int sampleRate, std::size_t maxLoopSeconds, unsigned int channels) {
    const unsigned int preparedChannels = channels == 2U ? 2U : 1U;
    if (sampleRate == 0U || sampleRate > kMaximumSampleRate || maxLoopSeconds > kMaximumLoopSeconds) {
        return false;
    }
    const std::size_t rate = static_cast<std::size_t>(sampleRate);
    if (maxLoopSeconds > std::numeric_limits<std::size_t>::max() / rate) return false;
    const std::size_t frames = rate * maxLoopSeconds;
    if (frames > std::numeric_limits<std::size_t>::max() / preparedChannels) return false;
    const std::size_t samples = frames * preparedChannels;
    if (samples > loopBuffer_.max_size()) return false;

    // Reconfiguring an identical prepared store only resets transport state;
    // it does not free/reallocate the committed pages on every stream start.
    if (sampleRate_ == sampleRate && maxLoopSeconds_ == maxLoopSeconds &&
        channels_ == preparedChannels && loopBuffer_.size() == samples) {
        prepareTransportCrossfadeLut();
        state_ = LooperState::Empty;
        monitoringEnabled_ = false;
        recordedFrames_ = 0U;
        finalizedFrames_ = 0U;
        playhead_ = 0U;
        vinylReadPosition_ = 0.0;
        vinylSpeedRatio_ = 1.0;
        vinylAcceleration_ = 0.0;
        transportFadeRemaining_ = 0U;
        updateBeatShiftOffsets();
        return true;
    }

    // A format change clears loop content in the existing host contract. Drop
    // old storage first so a reconfiguration never temporarily doubles the
    // bounded Native loop-memory footprint.
    std::vector<float>().swap(loopBuffer_);
    sampleRate_ = 0U;
    maxLoopSeconds_ = 0U;
    capacityFrames_ = 0U;
    channels_ = 1U;

    std::vector<float> prepared;
    try {
        prepared.resize(samples, 0.0f);
    } catch (const std::bad_alloc&) {
        return false;
    } catch (const std::length_error&) {
        return false;
    }

    // Explicitly touch each 4 KiB region on the caller/control thread. This
    // makes the memory commitment visible before recording enters the audio
    // callback, instead of relying only on vector::reserve virtual capacity.
    volatile float* const touched = prepared.data();
    constexpr std::size_t kPageStrideSamples = 4096U / sizeof(float);
    for (std::size_t sample = 0U; sample < samples; sample += kPageStrideSamples) {
        touched[sample] = 0.0f;
    }
    if (samples > 0U) touched[samples - 1U] = 0.0f;

    loopBuffer_.swap(prepared);
    sampleRate_ = sampleRate;
    maxLoopSeconds_ = maxLoopSeconds;
    capacityFrames_ = frames;
    channels_ = preparedChannels;
    state_ = LooperState::Empty;
    monitoringEnabled_ = false;
    recordedFrames_ = 0;
    finalizedFrames_ = 0;
    playhead_ = 0;
    vinylReadPosition_ = 0.0;
    vinylSpeedRatio_ = 1.0;
    vinylAcceleration_ = 0.0;
    transportFadeRemaining_ = 0U;
    prepareTransportCrossfadeLut();
    updateBeatShiftOffsets();
    return true;
}

void LooperCore::applyCommand(const Command& command) {
    switch (command.type) {
    case CommandType::Record:
        if (state_ == LooperState::Empty) {
            clearLoop();
            state_ = LooperState::Recording;
        }
        break;
    case CommandType::StopRecordOrPlayback:
        if (state_ == LooperState::Recording) {
            finalizedFrames_ = recordedFrames_;
            updateBeatShiftOffsets();
            playhead_ = 0;
            state_ = finalizedFrames_ > 0 ? LooperState::Stopped : LooperState::Empty;
            recordingMirror_ = nullptr; recordingMirrorFrames_ = 0U;
        } else if (state_ == LooperState::Playing || state_ == LooperState::Overdubbing) {
            playhead_ = 0;
            state_ = LooperState::Stopped;
        }
        break;
    case CommandType::FinishRecording:
        if (state_ == LooperState::Recording) {
            finalizedFrames_ = recordedFrames_;
            playhead_ = 0U; vinylReadPosition_ = 0.0;
            updateBeatShiftOffsets();
            state_ = finalizedFrames_ == 0U ? LooperState::Empty : LooperState::Stopped;
            if (finalizedFrames_ != 0U) {
                // One callback command owns the entire transition. Reuse the
                // normal source-transport start preparation without publishing
                // an intermediate Stopped state or accepting another command.
                applyCommand({CommandType::Play});
                if (command.boolValue && !loopTransportConfig_.oneShot) state_ = LooperState::Overdubbing;
            }
            recordingMirror_ = nullptr; recordingMirrorFrames_ = 0U;
        }
        break;
    case CommandType::SetRecordAction:
        break; // Owned by NativeAudioCore, not an individual looper.
    case CommandType::Play:
        if (state_ == LooperState::Playing && loopTransportConfig_.oneShot && finalizedFrames_ > 0U) {
            playhead_ = 0U;
            vinylReadPosition_ = 0.0;
            vinylSpeedRatio_ = 1.0;
            vinylAcceleration_ = 0.0;
            previousLoopTransportConfig_ = LoopTransportConfig{};
            previousBeatShiftOffsetSamples_ = 0.0;
            fadeStartVinylPosition_ = 0.0;
            fadeStartVinylSpeed_ = 1.0;
            transportFadeRemaining_ = loopTransportConfig_.mode == LoopTransportMode::Off ? 0U : transportFadeFrames_;
        }
        if (state_ == LooperState::Stopped && finalizedFrames_ > 0) {
            playhead_ = 0;
            vinylReadPosition_ = 0.0;
            vinylSpeedRatio_ = 1.0;
            vinylAcceleration_ = 0.0;
            // A transport configured before recording may have had its
            // pending fade cleared with the old loop. Re-enter from the
            // canonical head over the configured short fade when playback
            // starts, so the first transported sample is never a pointer
            // jump at the track boundary.
            if (loopTransportConfig_.mode != LoopTransportMode::Off) {
                previousLoopTransportConfig_ = LoopTransportConfig{};
                previousBeatShiftOffsetSamples_ = 0.0;
                fadeStartVinylPosition_ = 0.0;
                fadeStartVinylSpeed_ = 1.0;
                transportFadeRemaining_ = transportFadeFrames_;
            }
            state_ = LooperState::Playing;
        }
        break;
    case CommandType::ToggleOverdub:
        if (loopTransportConfig_.oneShot) break;
        if (state_ == LooperState::Playing) {
            state_ = LooperState::Overdubbing;
        } else if (state_ == LooperState::Overdubbing) {
            state_ = LooperState::Playing;
        }
        break;
    case CommandType::Clear:
        clearLoop();
        break;
    case CommandType::SetMonitoring:
        monitoringEnabled_ = command.boolValue;
        break;
    }
}

bool LooperCore::validLoopTransportConfig(const LoopTransportConfig& config) noexcept {
    if (config.mode != LoopTransportMode::Off && config.mode != LoopTransportMode::BeatShift &&
        config.mode != LoopTransportMode::VinylFlick) return false;
    return std::isfinite(config.beatOffsetBeats) && config.beatOffsetBeats >= -4.0f && config.beatOffsetBeats <= 4.0f &&
        std::isfinite(config.bpm) && config.bpm >= 20.0f && config.bpm <= 300.0f &&
        std::isfinite(config.crossfadeMs) && config.crossfadeMs >= 1.0f && config.crossfadeMs <= 10.0f &&
        std::isfinite(config.vinylSpeedPercent) && config.vinylSpeedPercent >= -100.0f && config.vinylSpeedPercent <= 100.0f &&
        std::isfinite(config.motorReturnSeconds) && config.motorReturnSeconds >= 0.05f && config.motorReturnSeconds <= 10.0f &&
        std::isfinite(config.brakePercent) && config.brakePercent >= 0.0f && config.brakePercent <= 100.0f &&
        std::isfinite(config.vinylMixPercent) && config.vinylMixPercent >= 0.0f && config.vinylMixPercent <= 100.0f;
}

bool LooperCore::setLoopTransportConfig(const LoopTransportConfig& config) noexcept {
    if (!validLoopTransportConfig(config)) return false;
    if (loopTransportConfig_.oneShot != config.oneShot &&
        (state_ == LooperState::Recording || state_ == LooperState::Playing || state_ == LooperState::Overdubbing)) return false;
    if (config.mode == LoopTransportMode::VinylFlick && sampleRate_ < 8000U) return false;
    if (loopTransportConfig_.mode == config.mode && loopTransportConfig_.oneShot == config.oneShot &&
        loopTransportConfig_.beatOffsetBeats == config.beatOffsetBeats &&
        loopTransportConfig_.bpm == config.bpm &&
        loopTransportConfig_.crossfadeMs == config.crossfadeMs &&
        loopTransportConfig_.vinylSpeedPercent == config.vinylSpeedPercent &&
        loopTransportConfig_.motorReturnSeconds == config.motorReturnSeconds &&
        loopTransportConfig_.brakePercent == config.brakePercent &&
        loopTransportConfig_.vinylMixPercent == config.vinylMixPercent) return true;

    const bool currentlyAudible = state_ == LooperState::Playing;
    previousLoopTransportConfig_ = currentlyAudible ? loopTransportConfig_ : LoopTransportConfig{};
    previousBeatShiftOffsetSamples_ = currentlyAudible ? beatShiftOffsetSamples_ : 0.0;
    fadeStartVinylPosition_ = currentlyAudible ? vinylReadPosition_ : static_cast<double>(playhead_);
    fadeStartVinylSpeed_ = currentlyAudible ? vinylSpeedRatio_ : 1.0;
    if (loopTransportConfig_.mode != LoopTransportMode::VinylFlick &&
        config.mode == LoopTransportMode::VinylFlick) {
        vinylReadPosition_ = static_cast<double>(playhead_);
        vinylSpeedRatio_ = 1.0;
        vinylAcceleration_ = 0.0;
    }
    loopTransportConfig_ = config;
    updateBeatShiftOffsets();
    const double requestedFade = static_cast<double>(sampleRate_) *
        static_cast<double>(config.crossfadeMs) * 0.001;
    transportFadeFrames_ = std::max<std::size_t>(1U, static_cast<std::size_t>(std::llround(requestedFade)));
    transportFadeRemaining_ = currentlyAudible || config.mode != LoopTransportMode::Off
        ? transportFadeFrames_ : 0U;
    return true;
}

LooperCore::PlaybackCursor LooperCore::playbackCursor() const noexcept {
    return {playhead_, transportFadeRemaining_, vinylReadPosition_, vinylSpeedRatio_, vinylAcceleration_};
}

void LooperCore::commitPlaybackCursor(const PlaybackCursor& cursor) noexcept {
    playhead_ = cursor.playhead; transportFadeRemaining_ = cursor.fadeRemaining;
    vinylReadPosition_ = cursor.vinylPosition; vinylSpeedRatio_ = cursor.vinylSpeed;
    vinylAcceleration_ = cursor.vinylAcceleration;
}

void LooperCore::readPlayingFrame(PlaybackCursor& cursor, float& left, float& right) const noexcept {
    left = right = 0.0f;
    if (finalizedFrames_ == 0U || cursor.playhead >= finalizedFrames_) return;
    const auto offset = cursor.playhead * channels_;
    left = loopBuffer_[offset]; right = channels_ == 2U ? loopBuffer_[offset + 1U] : left;
    if (loopTransportConfig_.mode == LoopTransportMode::BeatShift ||
         loopTransportConfig_.mode == LoopTransportMode::VinylFlick ||
         (cursor.fadeRemaining > 0U && previousLoopTransportConfig_.mode != LoopTransportMode::Off)) {
        const double canonicalPosition = static_cast<double>(cursor.playhead);
        double transportedPosition = canonicalPosition;
        bool transportedLagrange = false;
        if (loopTransportConfig_.mode == LoopTransportMode::BeatShift) {
            transportedPosition = beatShiftPosition(canonicalPosition, beatShiftOffsetSamples_);
            transportedLagrange = true;
        } else if (loopTransportConfig_.mode == LoopTransportMode::VinylFlick) {
            transportedPosition = cursor.vinylPosition;
            transportedLagrange = true;
        }

        float transportedLeft = 0.0f;
        float transportedRight = 0.0f;
        readLoopAt(transportedPosition, transportedLagrange, transportedLeft, transportedRight);
        if (loopTransportConfig_.mode == LoopTransportMode::VinylFlick) {
            const float wet = std::clamp(loopTransportConfig_.vinylMixPercent * 0.01f, 0.0f, 1.0f);
            transportedLeft = left + ((transportedLeft - left) * wet);
            transportedRight = right + ((transportedRight - right) * wet);
        }

        if (cursor.fadeRemaining > 0U) {
            const std::size_t elapsed = transportFadeFrames_ - cursor.fadeRemaining;
            double previousPosition = canonicalPosition;
            bool previousLagrange = false;
            if (previousLoopTransportConfig_.mode == LoopTransportMode::BeatShift) {
                previousPosition = beatShiftPosition(canonicalPosition, previousBeatShiftOffsetSamples_);
                previousLagrange = true;
            } else if (previousLoopTransportConfig_.mode == LoopTransportMode::VinylFlick) {
                previousPosition = fadeStartVinylPosition_ +
                    static_cast<double>(elapsed) * std::clamp(fadeStartVinylSpeed_, 0.0, 2.0);
                previousLagrange = true;
            }
            float previousLeft = 0.0f;
            float previousRight = 0.0f;
            readLoopAt(previousPosition, previousLagrange, previousLeft, previousRight);
            if (previousLoopTransportConfig_.mode == LoopTransportMode::VinylFlick) {
                const float previousWet = std::clamp(previousLoopTransportConfig_.vinylMixPercent * 0.01f, 0.0f, 1.0f);
                previousLeft = left + ((previousLeft - left) * previousWet);
                previousRight = right + ((previousRight - right) * previousWet);
            }
            const double progress = transportFadeFrames_ <= 1U ? 1.0 :
                static_cast<double>(elapsed) / static_cast<double>(transportFadeFrames_ - 1U);
            double oldGain = 0.0;
            double newGain = 0.0;
            getTransportCrossfadeGains(progress, oldGain, newGain);
            transportedLeft = static_cast<float>(previousLeft * oldGain + transportedLeft * newGain);
            transportedRight = static_cast<float>(previousRight * oldGain + transportedRight * newGain);
            --cursor.fadeRemaining;
        }
        left = transportedLeft;
        right = transportedRight;
    }

    if (loopTransportConfig_.mode == LoopTransportMode::VinylFlick) {
        advanceVinylPlatter(cursor);
        cursor.vinylPosition = wrappedLoopPosition(cursor.vinylPosition + cursor.vinylSpeed);
    }
    if (loopTransportConfig_.oneShot) {
        ++cursor.playhead;
    } else {
        cursor.playhead = (cursor.playhead + 1U) % finalizedFrames_;
    }
}

bool LooperCore::previewPlayback(float* destination, unsigned int frames,
    unsigned int outputChannels, unsigned int capacityFrames) const noexcept {
    if (destination == nullptr || frames > capacityFrames || frames > 4096U ||
        outputChannels == 0U || outputChannels > 2U) return false;
    std::fill_n(destination, static_cast<std::size_t>(frames) * outputChannels, 0.0f);
    if ((state_ != LooperState::Playing && state_ != LooperState::Overdubbing) || finalizedFrames_ == 0U) return false;
    if (state_ == LooperState::Playing) {
        auto cursor = playbackCursor();
        for (unsigned int frame = 0U; frame < frames; ++frame) {
            if (loopTransportConfig_.oneShot && cursor.playhead >= finalizedFrames_) break;
            float left, right; readPlayingFrame(cursor, left, right);
            destination[static_cast<std::size_t>(frame) * outputChannels] = left;
            if (outputChannels == 2U) destination[static_cast<std::size_t>(frame) * 2U + 1U] = right;
        }
    } else {
        // The overdub renderer reads its canonical playhead directly rather
        // than through the Playing transport cursor. Mirror that read order
        // into a local head so source preview and recording start at one block
        // boundary without advancing the live transport a second time.
        std::size_t previewHead = playhead_;
        for (unsigned int frame = 0U; frame < frames; ++frame) {
            const std::size_t offset = previewHead * channels_;
            const float left = loopBuffer_[offset];
            const float right = channels_ == 2U ? loopBuffer_[offset + 1U] : left;
            destination[static_cast<std::size_t>(frame) * outputChannels] = left;
            if (outputChannels == 2U) destination[static_cast<std::size_t>(frame) * 2U + 1U] = right;
            if (++previewHead == finalizedFrames_) previewHead = 0U;
        }
    }
    return true;
}

ProcessStats LooperCore::process(
    const float* inputInterleaved,
    float* outputInterleaved,
    unsigned int frames,
    unsigned int inputChannels,
    unsigned int outputChannels,
    float* playbackOnlyInterleaved,
    bool measureOutputPeak,
    const float* monitorInputInterleaved,
    unsigned int monitorInputChannels
) {
    ProcessStats stats;
    stats.state = state_;
    stats.loopTransportStatus = transportStatusForState();
    const bool playbackWasActive = state_ == LooperState::Playing;

    auto cursor = playbackCursor();
    for (unsigned int frame = 0; frame < frames; ++frame) {
        const std::size_t inputOffset = static_cast<std::size_t>(frame) * inputChannels;
        const float inputLeft = inputInterleaved != nullptr && inputChannels > 0U
            ? inputInterleaved[inputOffset]
            : 0.0f;
        const float inputRight = inputInterleaved != nullptr && inputChannels > 1U
            ? inputInterleaved[inputOffset + 1U]
            : inputLeft;
        const unsigned int effectiveMonitorChannels = monitorInputChannels > 0U
            ? monitorInputChannels : inputChannels;
        const float monitorLeft = monitorInputInterleaved != nullptr && effectiveMonitorChannels > 0U
            ? monitorInputInterleaved[static_cast<std::size_t>(frame) * effectiveMonitorChannels]
            : inputLeft;
        const float monitorRight = monitorInputInterleaved != nullptr
            ? (effectiveMonitorChannels > 1U
                ? monitorInputInterleaved[static_cast<std::size_t>(frame) * effectiveMonitorChannels + 1U]
                : monitorLeft)
            : inputRight;

        float playbackLeft = 0.0f;
        float playbackRight = 0.0f;
        if (state_ == LooperState::Playing) {
            readPlayingFrame(cursor, playbackLeft, playbackRight);
        } else if (state_ == LooperState::Overdubbing && finalizedFrames_ > 0U && playhead_ < finalizedFrames_) {
            const auto loopOffset = playhead_ * channels_;
            playbackLeft = loopBuffer_[loopOffset];
            playbackRight = channels_ == 2U ? loopBuffer_[loopOffset + 1U] : playbackLeft;
        }

        float outputLeft = 0.0f;
        float outputRight = 0.0f;
        if (state_ == LooperState::Recording) {
            if (recordedFrames_ < capacityFrames_) {
                const std::size_t recordOffset = recordedFrames_ * channels_;
                loopBuffer_[recordOffset] = inputLeft;
                if (channels_ == 2U) {
                    loopBuffer_[recordOffset + 1U] = inputRight;
                }
                if (recordingMirror_ != nullptr && recordedFrames_ < recordingMirrorFrames_) {
                    recordingMirror_[recordedFrames_ * 2U] = inputLeft;
                    recordingMirror_[recordedFrames_ * 2U + 1U] = inputRight;
                }
                ++recordedFrames_;
            }
            outputLeft = monitoringEnabled_ ? monitorLeft : 0.0f;
            outputRight = monitoringEnabled_ ? monitorRight : 0.0f;
        } else if (state_ == LooperState::Playing) {
            outputLeft = playbackLeft + (monitoringEnabled_ ? monitorLeft : 0.0f);
            outputRight = playbackRight + (monitoringEnabled_ ? monitorRight : 0.0f);
            if (loopTransportConfig_.oneShot && cursor.playhead >= finalizedFrames_) {
                state_ = LooperState::Stopped;
                cursor.playhead = 0U;
            }
        } else if (state_ == LooperState::Overdubbing) {
            const float mixedLeft = clampSample(playbackLeft + inputLeft);
            const float mixedRight = clampSample(playbackRight + inputRight);
            if (finalizedFrames_ > 0 && playhead_ < finalizedFrames_) {
                const std::size_t loopOffset = playhead_ * channels_;
                loopBuffer_[loopOffset] = mixedLeft;
                if (channels_ == 2U) loopBuffer_[loopOffset + 1U] = mixedRight;
                playhead_ = (playhead_ + 1) % finalizedFrames_;
            }
            // Keep the established always-audible overdub monitor behavior,
            // while the recorded contribution may now use a separate source.
            outputLeft = clampSample(playbackLeft + monitorLeft);
            outputRight = clampSample(playbackRight + monitorRight);
        } else {
            outputLeft = monitoringEnabled_ ? monitorLeft : 0.0f;
            outputRight = monitoringEnabled_ ? monitorRight : 0.0f;
        }

        outputLeft = clampSample(outputLeft);
        outputRight = clampSample(outputRight);
        stats.inputPeak = std::max(stats.inputPeak, std::max(std::fabs(inputLeft), std::fabs(inputRight)));
        if (measureOutputPeak) {
            stats.outputPeak = std::max(stats.outputPeak, std::max(std::fabs(outputLeft), std::fabs(outputRight)));
        }

        if (outputInterleaved != nullptr && outputChannels > 0) {
            const std::size_t offset = static_cast<std::size_t>(frame) * outputChannels;
            for (unsigned int channel = 0; channel < outputChannels; ++channel) {
                const float out = channel == 0U ? outputLeft : channel == 1U ? outputRight
                    : channels_ == 1U ? outputLeft : ((channel & 1U) == 0U ? outputLeft : outputRight);
                const float playback = channel == 0U ? playbackLeft : channel == 1U ? playbackRight
                    : channels_ == 1U ? playbackLeft : ((channel & 1U) == 0U ? playbackLeft : playbackRight);
                outputInterleaved[offset + channel] = out;
                if (playbackOnlyInterleaved != nullptr) playbackOnlyInterleaved[offset + channel] = playback;
            }
        } else if (playbackOnlyInterleaved != nullptr && outputChannels > 0) {
            const std::size_t offset = static_cast<std::size_t>(frame) * outputChannels;
            for (unsigned int channel = 0; channel < outputChannels; ++channel) {
                playbackOnlyInterleaved[offset + channel] = channel == 0U ? playbackLeft
                    : channel == 1U ? playbackRight : (channels_ == 1U ? playbackLeft : ((channel & 1U) == 0U ? playbackLeft : playbackRight));
            }
        }
    }

    if (playbackWasActive) commitPlaybackCursor(cursor);
    stats.state = state_;
    stats.loopTransportStatus = transportStatusForState();
    if (finalizedFrames_ > 0 && (state_ == LooperState::Playing || state_ == LooperState::Overdubbing)) {
        stats.loopProgress = static_cast<float>(playhead_) / static_cast<float>(finalizedFrames_);
    } else {
        stats.loopProgress = 0.0f;
    }

    return stats;
}

double LooperCore::wrappedLoopPosition(double position) const noexcept {
    if (finalizedFrames_ == 0U || !std::isfinite(position)) return 0.0;
    const double length = static_cast<double>(finalizedFrames_);
    if (position >= 0.0 && position < length) return position;
    if (position < 0.0 && position >= -length) return position + length;
    if (position >= length && position < (2.0 * length)) return position - length;
    position = std::fmod(position, length);
    if (position < 0.0) position += length;
    return position;
}

void LooperCore::readLoopAt(double position, bool useLagrange4, float& left, float& right) const noexcept {
    left = 0.0f;
    right = 0.0f;
    if (finalizedFrames_ == 0U) return;
    position = wrappedLoopPosition(position);
    const auto frameAt = [this](std::int64_t frame) noexcept -> std::size_t {
        const auto length = static_cast<std::int64_t>(finalizedFrames_);
        frame %= length;
        if (frame < 0) frame += length;
        return static_cast<std::size_t>(frame);
    };
    const auto readChannel = [this, &frameAt](std::int64_t frame, unsigned int channel) noexcept {
        const std::size_t offset = frameAt(frame) * channels_;
        return loopBuffer_[offset + (channels_ == 2U ? channel : 0U)];
    };
    const auto base = static_cast<std::int64_t>(std::floor(position));
    const float fraction = static_cast<float>(position - static_cast<double>(base));
    const auto read = [&](unsigned int channel) noexcept {
        if (useLagrange4) {
            return dsp::lagrange4(readChannel(base - 1, channel), readChannel(base, channel),
                                  readChannel(base + 1, channel), readChannel(base + 2, channel), fraction);
        }
        const float first = readChannel(base, channel);
        const float second = readChannel(base + 1, channel);
        return first + ((second - first) * fraction);
    };
    left = read(0U);
    right = channels_ == 2U ? read(1U) : left;
}

double LooperCore::beatShiftPosition(double canonicalPosition, double normalizedOffset) const noexcept {
    if (finalizedFrames_ == 0U) return 0.0;
    const double length = static_cast<double>(finalizedFrames_);
    double position = canonicalPosition + normalizedOffset;
    if (position >= length) position -= length;
    else if (position < 0.0) position += length;
    return position;
}

void LooperCore::updateBeatShiftOffsets() noexcept {
    if (finalizedFrames_ == 0U || sampleRate_ == 0U) {
        beatShiftOffsetSamples_ = 0.0;
        previousBeatShiftOffsetSamples_ = 0.0;
        return;
    }
    const double length = static_cast<double>(finalizedFrames_);
    const double framesPerBeat = static_cast<double>(sampleRate_) * 60.0 /
        static_cast<double>(loopTransportConfig_.bpm);
    beatShiftOffsetSamples_ = std::fmod(
        framesPerBeat * static_cast<double>(loopTransportConfig_.beatOffsetBeats), length);
    if (beatShiftOffsetSamples_ < 0.0) beatShiftOffsetSamples_ += length;
}

void LooperCore::prepareTransportCrossfadeLut() noexcept {
    for (std::size_t index = 0U; index <= kTransportCrossfadeLutSize; ++index) {
        const double progress = static_cast<double>(index) / static_cast<double>(kTransportCrossfadeLutSize);
        const double angle = progress * 1.57079632679489661923;
        transportFadeOldGainLut_[index] = static_cast<float>(std::cos(angle));
        transportFadeNewGainLut_[index] = static_cast<float>(std::sin(angle));
    }
}

void LooperCore::getTransportCrossfadeGains(double progress, double& oldGain, double& newGain) const noexcept {
    const double bounded = std::clamp(progress, 0.0, 1.0) * static_cast<double>(kTransportCrossfadeLutSize);
    const auto index = std::min<std::size_t>(static_cast<std::size_t>(bounded), kTransportCrossfadeLutSize);
    const auto next = std::min(index + 1U, kTransportCrossfadeLutSize);
    const float fraction = static_cast<float>(bounded - static_cast<double>(index));
    oldGain = transportFadeOldGainLut_[index] +
        (transportFadeOldGainLut_[next] - transportFadeOldGainLut_[index]) * fraction;
    newGain = transportFadeNewGainLut_[index] +
        (transportFadeNewGainLut_[next] - transportFadeNewGainLut_[index]) * fraction;
}

void LooperCore::advanceVinylPlatter(PlaybackCursor& cursor) const noexcept {
    const double target = std::clamp(1.0 + static_cast<double>(loopTransportConfig_.vinylSpeedPercent) * 0.01, 0.0, 2.0);
    const double tau = std::clamp(static_cast<double>(loopTransportConfig_.motorReturnSeconds), 0.05, 10.0);
    const double brake = std::clamp(static_cast<double>(loopTransportConfig_.brakePercent) * 0.01, 0.0, 1.0);
    const double omega = 2.0 / tau;
    const double dampingRatio = 0.7 + (1.2 * brake);
    const double accelerationDerivative = (omega * omega * (target - cursor.vinylSpeed)) -
        (2.0 * dampingRatio * omega * cursor.vinylAcceleration);
    const double dt = sampleRate_ == 0U ? 0.0 : 1.0 / static_cast<double>(sampleRate_);
    cursor.vinylAcceleration = std::clamp(cursor.vinylAcceleration + (accelerationDerivative * dt), -100.0, 100.0);
    const double nextSpeed = cursor.vinylSpeed + (cursor.vinylAcceleration * dt);
    if (nextSpeed <= 0.0 || nextSpeed >= 2.0) cursor.vinylAcceleration = 0.0;
    cursor.vinylSpeed = std::clamp(nextSpeed, 0.0, 2.0);
}

LoopTransportStatus LooperCore::transportStatusForState() const noexcept {
    if (loopTransportConfig_.mode == LoopTransportMode::Off) return LoopTransportStatus::Disabled;
    if (state_ == LooperState::Recording) return LoopTransportStatus::UnsupportedRecording;
    if (state_ == LooperState::Overdubbing) return LoopTransportStatus::UnsupportedOverdubbing;
    if (finalizedFrames_ == 0U || state_ == LooperState::Empty) return LoopTransportStatus::WaitingForLoop;
    if (state_ == LooperState::Playing) return LoopTransportStatus::Active;
    return LoopTransportStatus::WaitingForPlayback;
}

LooperState LooperCore::state() const noexcept {
    return state_;
}

bool LooperCore::monitoringEnabled() const noexcept {
    return monitoringEnabled_;
}

unsigned int LooperCore::sampleRate() const noexcept {
    return sampleRate_;
}

std::uint64_t LooperCore::loopLengthSamples() const noexcept {
    return static_cast<std::uint64_t>(finalizedFrames_);
}

std::size_t LooperCore::storageBytes() const noexcept {
    return loopBuffer_.size() * sizeof(float);
}

std::size_t LooperCore::capacityFrames() const noexcept {
    return capacityFrames_;
}

unsigned int LooperCore::channels() const noexcept {
    return channels_;
}

LoopMetadata LooperCore::metadata() const noexcept {
    return {state_, recordedFrames_, finalizedFrames_, playhead_};
}

void LooperCore::restoreMetadata(const LoopMetadata& metadata) noexcept {
    state_ = metadata.state;
    recordedFrames_ = std::min(metadata.recordedFrames, capacityFrames_);
    finalizedFrames_ = std::min(metadata.finalizedFrames, capacityFrames_);
    playhead_ = finalizedFrames_ == 0U ? 0U : metadata.playhead % finalizedFrames_;
    updateBeatShiftOffsets();
}

bool LooperCore::exchangeFinalizedStereoSamples(float* samples, std::size_t frames) noexcept {
    if (samples == nullptr || frames == 0U || frames != finalizedFrames_ || frames > capacityFrames_) return false;
    for (std::size_t frame = 0U; frame < frames; ++frame) {
        const std::size_t loopOffset = frame * channels_;
        const float oldLeft = loopBuffer_[loopOffset];
        const float oldRight = channels_ == 2U ? loopBuffer_[loopOffset + 1U] : oldLeft;
        loopBuffer_[loopOffset] = samples[frame * 2U];
        if (channels_ == 2U) loopBuffer_[loopOffset + 1U] = samples[frame * 2U + 1U];
        samples[frame * 2U] = oldLeft;
        samples[frame * 2U + 1U] = oldRight;
    }
    return true;
}

bool LooperCore::swapImportedStereoStorage(
    std::vector<float>& fullCapacitySamples,
    std::size_t frames
) noexcept {
    const auto expectedSamples = capacityFrames_ * 2U;
    if (channels_ != 2U || fullCapacitySamples.size() != expectedSamples ||
        frames > capacityFrames_ || (frames > 0U && fullCapacitySamples.empty())) {
        return false;
    }

    // std::vector::swap with the standard allocator is noexcept and leaves
    // the old full-capacity store in the staging transaction for control-side
    // reclamation after this callback acknowledges the commit.
    loopBuffer_.swap(fullCapacitySamples);
    state_ = frames == 0U ? LooperState::Empty : LooperState::Stopped;
    recordedFrames_ = frames;
    finalizedFrames_ = frames;
    playhead_ = 0U;
    transportFadeRemaining_ = 0U;
    vinylReadPosition_ = 0.0;
    vinylSpeedRatio_ = 1.0;
    vinylAcceleration_ = 0.0;
    updateBeatShiftOffsets();
    return true;
}

bool LooperCore::copyFinalizedLoopSnapshot(
    float* destination,
    std::size_t destinationFrames,
    std::size_t& copiedFrames
) const noexcept {
    copiedFrames = 0U;
    if (destination == nullptr || finalizedFrames_ == 0U || destinationFrames < finalizedFrames_) {
        return false;
    }

    if (channels_ == 1U) {
        std::copy_n(loopBuffer_.data(), finalizedFrames_, destination);
    } else {
        for (std::size_t frame = 0U; frame < finalizedFrames_; ++frame) {
            destination[frame] = 0.5f * (loopBuffer_[frame * 2U] + loopBuffer_[frame * 2U + 1U]);
        }
    }
    copiedFrames = finalizedFrames_;
    return true;
}

bool LooperCore::copyFinalizedStereoLoopSnapshot(
    float* destination,
    std::size_t destinationFrames,
    std::size_t& copiedFrames
) const noexcept {
    copiedFrames = 0U;
    if (destination == nullptr || finalizedFrames_ == 0U || destinationFrames < finalizedFrames_) return false;
    for (std::size_t frame = 0U; frame < finalizedFrames_; ++frame) {
        const std::size_t offset = frame * channels_;
        destination[frame * 2U] = loopBuffer_[offset];
        destination[frame * 2U + 1U] = channels_ == 2U ? loopBuffer_[offset + 1U] : loopBuffer_[offset];
    }
    copiedFrames = finalizedFrames_;
    return true;
}

void LooperCore::clearLoop() {
    recordingMirror_ = nullptr; recordingMirrorFrames_ = 0U;
    state_ = LooperState::Empty;
    recordedFrames_ = 0;
    finalizedFrames_ = 0;
    playhead_ = 0;
    vinylReadPosition_ = 0.0;
    vinylSpeedRatio_ = 1.0;
    vinylAcceleration_ = 0.0;
    transportFadeRemaining_ = 0U;
    updateBeatShiftOffsets();
}

float LooperCore::clampSample(float value) noexcept {
    return std::max(-1.0f, std::min(1.0f, value));
}

} // namespace webrc::native
