#ifdef NDEBUG
#undef NDEBUG
#endif

#include "native_audio_core.hpp"

#include <algorithm>
#include <array>
#include <atomic>
#include <cassert>
#include <thread>
#include <vector>

using namespace webrc::native;

namespace {

void testLooperTransportAndClear() {
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
    for (unsigned int frame = 0; frame < 16; ++frame) {
        assert(output[frame * 2] == 0.0f);
        assert(output[frame * 2 + 1] == 0.0f);
    }

    // A shorter recording after Clear must not play stale samples left in the
    // old tail of the backing buffer.
    std::fill(input.begin(), input.end(), 0.75f);
    looper.applyCommand({CommandType::Record, false});
    looper.process(input.data(), output.data(), 8, 1, 2);
    looper.applyCommand({CommandType::StopRecordOrPlayback, false});
    looper.applyCommand({CommandType::Play, false});
    looper.process(input.data(), output.data(), 16, 1, 2);
    for (unsigned int frame = 0; frame < 8; ++frame) {
        assert(output[frame * 2] == 0.75f);
        assert(output[frame * 2 + 1] == 0.75f);
    }
    for (unsigned int frame = 8; frame < 16; ++frame) {
        assert(output[frame * 2] == 0.75f);
        assert(output[frame * 2 + 1] == 0.75f);
    }

    looper.prepare(48000, 10);
    assert(looper.state() == LooperState::Empty);
}

void testInvalidCommandsDoNotChangeState() {
    LooperCore looper(48000, 1);
    const auto invalid = static_cast<CommandType>(0xff);
    looper.applyCommand({invalid, true});
    assert(looper.state() == LooperState::Empty);

    looper.applyCommand({CommandType::Play, false});
    assert(looper.state() == LooperState::Empty);
    looper.applyCommand({CommandType::StopRecordOrPlayback, false});
    assert(looper.state() == LooperState::Empty);
    looper.applyCommand({CommandType::ToggleOverdub, false});
    assert(looper.state() == LooperState::Empty);
}

void testCommandQueueMultiProducerSerialization() {
    constexpr unsigned int producerCount = 4;
    constexpr unsigned int commandsPerProducer = 1000;
    constexpr unsigned int expectedCommands = producerCount * commandsPerProducer;
    using TestQueue = SerializedProducerRingQueue<Command, expectedCommands + 1>;
    TestQueue queue;
    std::array<std::atomic<unsigned int>, 6> consumed{};
    std::atomic<unsigned int> producersDone{0};

    std::thread consumer([&] {
        while (producersDone.load(std::memory_order_acquire) < producerCount || queue.size() > 0) {
            Command command{};
            if (queue.pop(command)) {
                const auto index = static_cast<std::size_t>(command.type);
                assert(index < consumed.size());
                consumed[index].fetch_add(1, std::memory_order_relaxed);
            } else {
                std::this_thread::yield();
            }
        }
    });

    std::array<std::thread, producerCount> producers;
    for (unsigned int producer = 0; producer < producerCount; ++producer) {
        producers[producer] = std::thread([producer, &queue, &producersDone, &consumed, commandsPerProducer] {
            for (unsigned int index = 0; index < commandsPerProducer; ++index) {
                const auto commandType = static_cast<CommandType>((producer + index) % consumed.size());
                const bool accepted = queue.push({commandType, (index & 1u) != 0});
                assert(accepted);
            }
            producersDone.fetch_add(1, std::memory_order_release);
        });
    }

    for (auto& producer : producers) {
        producer.join();
    }
    consumer.join();

    unsigned int totalConsumed = 0;
    for (const auto& count : consumed) {
        totalConsumed += count.load(std::memory_order_relaxed);
    }
    assert(totalConsumed == expectedCommands);
    assert(queue.dropped() == 0);
}

void testCommandQueueDropCounter() {
    SerializedProducerRingQueue<Command, 4> queue;
    assert((SerializedProducerRingQueue<Command, 4>::usableCapacity() == 3));
    assert(queue.push({CommandType::Record, false}));
    assert(queue.push({CommandType::Play, false}));
    assert(queue.push({CommandType::Clear, false}));
    assert(!queue.push({CommandType::ToggleOverdub, false}));
    assert(queue.dropped() == 1);

    Command command{};
    assert(queue.pop(command) && command.type == CommandType::Record);
    assert(queue.pop(command) && command.type == CommandType::Play);
    assert(queue.pop(command) && command.type == CommandType::Clear);
    assert(!queue.pop(command));

    queue.clear();
    assert(queue.dropped() == 1);
    queue.resetDropped();
    assert(queue.dropped() == 0);
}

} // namespace

int main() {
    testLooperTransportAndClear();
    testInvalidCommandsDoNotChangeState();
    testCommandQueueMultiProducerSerialization();
    testCommandQueueDropCounter();
    return 0;
}
