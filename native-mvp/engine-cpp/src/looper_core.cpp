#include "looper_core.hpp"

#include <algorithm>
#include <cmath>

namespace webrc::native {

LooperCore::LooperCore(unsigned int sampleRate, std::size_t maxLoopSeconds)
    : sampleRate_(sampleRate),
      maxLoopSeconds_(maxLoopSeconds),
      capacityFrames_(static_cast<std::size_t>(sampleRate) * maxLoopSeconds),
      loopBuffer_(capacityFrames_, 0.0f),
      state_(LooperState::Empty),
      monitoringEnabled_(false),
      recordedFrames_(0),
      finalizedFrames_(0),
      playhead_(0) {}

void LooperCore::prepare(unsigned int sampleRate, std::size_t maxLoopSeconds) {
    sampleRate_ = sampleRate;
    maxLoopSeconds_ = maxLoopSeconds;
    capacityFrames_ = static_cast<std::size_t>(sampleRate_) * maxLoopSeconds_;
    loopBuffer_.assign(capacityFrames_, 0.0f);
    state_ = LooperState::Empty;
    monitoringEnabled_ = false;
    recordedFrames_ = 0;
    finalizedFrames_ = 0;
    playhead_ = 0;
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
            playhead_ = 0;
            state_ = finalizedFrames_ > 0 ? LooperState::Stopped : LooperState::Empty;
        } else if (state_ == LooperState::Playing || state_ == LooperState::Overdubbing) {
            playhead_ = 0;
            state_ = LooperState::Stopped;
        }
        break;
    case CommandType::Play:
        if (state_ == LooperState::Stopped && finalizedFrames_ > 0) {
            playhead_ = 0;
            state_ = LooperState::Playing;
        }
        break;
    case CommandType::ToggleOverdub:
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

ProcessStats LooperCore::process(
    const float* inputInterleaved,
    float* outputInterleaved,
    unsigned int frames,
    unsigned int inputChannels,
    unsigned int outputChannels
) {
    ProcessStats stats;
    stats.state = state_;

    for (unsigned int frame = 0; frame < frames; ++frame) {
        const float inputSample =
            (inputInterleaved != nullptr && inputChannels > 0)
                ? inputInterleaved[static_cast<std::size_t>(frame) * inputChannels]
                : 0.0f;

        float playbackSample = 0.0f;
        if (finalizedFrames_ > 0 &&
            (state_ == LooperState::Playing || state_ == LooperState::Overdubbing) &&
            playhead_ < finalizedFrames_) {
            playbackSample = loopBuffer_[playhead_];
        }

        float outputSample = 0.0f;
        if (state_ == LooperState::Recording) {
            if (recordedFrames_ < capacityFrames_) {
                loopBuffer_[recordedFrames_] = inputSample;
                ++recordedFrames_;
            }
            outputSample = monitoringEnabled_ ? inputSample : 0.0f;
        } else if (state_ == LooperState::Playing) {
            outputSample = playbackSample + (monitoringEnabled_ ? inputSample : 0.0f);
            if (finalizedFrames_ > 0) {
                playhead_ = (playhead_ + 1) % finalizedFrames_;
            }
        } else if (state_ == LooperState::Overdubbing) {
            const float mixed = clampSample(playbackSample + inputSample);
            if (finalizedFrames_ > 0 && playhead_ < finalizedFrames_) {
                loopBuffer_[playhead_] = mixed;
                playhead_ = (playhead_ + 1) % finalizedFrames_;
            }
            outputSample = mixed;
        } else {
            outputSample = monitoringEnabled_ ? inputSample : 0.0f;
        }

        outputSample = clampSample(outputSample);
        stats.inputPeak = std::max(stats.inputPeak, std::fabs(inputSample));
        stats.outputPeak = std::max(stats.outputPeak, std::fabs(outputSample));

        if (outputInterleaved != nullptr && outputChannels > 0) {
            const std::size_t offset = static_cast<std::size_t>(frame) * outputChannels;
            for (unsigned int channel = 0; channel < outputChannels; ++channel) {
                outputInterleaved[offset + channel] = outputSample;
            }
        }
    }

    stats.state = state_;
    if (finalizedFrames_ > 0 && (state_ == LooperState::Playing || state_ == LooperState::Overdubbing)) {
        stats.loopProgress = static_cast<float>(playhead_) / static_cast<float>(finalizedFrames_);
    } else {
        stats.loopProgress = 0.0f;
    }

    return stats;
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

void LooperCore::clearLoop() {
    std::fill(loopBuffer_.begin(), loopBuffer_.end(), 0.0f);
    state_ = LooperState::Empty;
    recordedFrames_ = 0;
    finalizedFrames_ = 0;
    playhead_ = 0;
}

float LooperCore::clampSample(float value) noexcept {
    return std::max(-1.0f, std::min(1.0f, value));
}

} // namespace webrc::native
