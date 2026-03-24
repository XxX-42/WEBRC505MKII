#include "looper_core.hpp"

#include <cassert>
#include <vector>

using namespace webrc::native;

int main() {
    LooperCore looper(48000, 10);
    std::vector<float> input(256, 0.25f);
    std::vector<float> output(512, 0.0f);

    looper.applyCommand({CommandType::Record, false});
    auto stats = looper.process(input.data(), output.data(), 256, 1, 2);
    assert(stats.state == LooperState::Recording);

    looper.applyCommand({CommandType::StopRecordOrPlayback, false});
    stats = looper.process(input.data(), output.data(), 16, 1, 2);
    assert(stats.state == LooperState::Stopped);

    looper.applyCommand({CommandType::Play, false});
    stats = looper.process(input.data(), output.data(), 16, 1, 2);
    assert(stats.state == LooperState::Playing);

    looper.applyCommand({CommandType::ToggleOverdub, false});
    stats = looper.process(input.data(), output.data(), 16, 1, 2);
    assert(stats.state == LooperState::Overdubbing);

    looper.applyCommand({CommandType::ToggleOverdub, false});
    stats = looper.process(input.data(), output.data(), 16, 1, 2);
    assert(stats.state == LooperState::Playing);

    looper.applyCommand({CommandType::Clear, false});
    stats = looper.process(input.data(), output.data(), 16, 1, 2);
    assert(stats.state == LooperState::Empty);

    return 0;
}
