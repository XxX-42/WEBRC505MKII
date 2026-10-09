#include "native_fx_control.hpp"

#include <atomic>
#include <cstdlib>
#include <iostream>
#include <new>

namespace {
std::atomic<bool> watching{false};
std::atomic<unsigned long long> allocationCount{0};
std::atomic<unsigned long long> allocatedBytes{0};
}

void* operator new(std::size_t size) {
    if (watching.load(std::memory_order_relaxed)) {
        allocationCount.fetch_add(1, std::memory_order_relaxed);
        allocatedBytes.fetch_add(size, std::memory_order_relaxed);
    }
    if (void* p = std::malloc(size ? size : 1)) return p;
    throw std::bad_alloc();
}
void* operator new[](std::size_t size) { return ::operator new(size); }
void operator delete(void* p) noexcept { std::free(p); }
void operator delete[](void* p) noexcept { std::free(p); }
void operator delete(void* p, std::size_t) noexcept { std::free(p); }
void operator delete[](void* p, std::size_t) noexcept { std::free(p); }

using namespace webrc::native;
using namespace webrc::dsp;

struct Observation {
    const char* name;
    NativeFxBankStatus status;
    unsigned long long allocations;
    unsigned long long bytes;
    bool correctRejection;
};

NativeFxBankConfig configuration(unsigned rate, float frequency) {
    NativeFxBankConfig c{};
    c.sampleRateHz = rate;
    auto& s = c.buses[1][0];
    s.enabled = true;
    s.ordinal = 1;
    s.parameterCount = 1;
    s.parameters[0] = {FxParameterId::FrequencyHz, frequency};
    return c;
}

Observation observe(const char* name, NativeFxBank& bank,
                    const NativeFxBankConfig& c, NativeFxBankStatus expected) {
    allocationCount.store(0);
    allocatedBytes.store(0);
    watching.store(true);
    const auto result = bank.configure(c);
    watching.store(false);
    return {name, result.status, allocationCount.load(), allocatedBytes.load(),
            result.status == expected && !bank.configured()};
}

int main() {
    NativeTrackHost tiny, lowRate, absent;
    const auto history = MultiTrackLooperCore::requiredTrackBufferBytes(48000, 1) * kNativeTrackCount;
    const auto budget = NativeTrackHost::requiredFixedMemoryBytes() + history + 1;
    if (!tiny.prepare(48000, 1, budget) || tiny.candidateFxGraphBudgetBytes() != 1 ||
        !lowRate.prepare(8000, 1)) return 2;
    NativeFxBank tinyBank(tiny), lowBank(lowRate), absentBank(absent);
    const Observation cases[] = {
        observe("one-byte-remaining-budget", tinyBank, configuration(48000, 1000), NativeFxBankStatus::MemoryBudgetExceeded),
        observe("unprepared-host", absentBank, configuration(48000, 1000), NativeFxBankStatus::HostNotPrepared),
        observe("sample-rate-mismatch", lowBank, configuration(48000, 1000), NativeFxBankStatus::InvalidSpec),
        observe("nyquist-invalid", lowBank, configuration(8000, 5000), NativeFxBankStatus::InvalidParameter),
    };
    bool reproduced = true;
    std::cout << "{\n  \"softwareOnly\":true,\n  \"hardwareStreamStarted\":false,\n  \"cases\":[\n";
    for (unsigned i = 0; i < 4; ++i) {
        const auto& c = cases[i];
        reproduced &= c.correctRejection && c.allocations > 0;
        std::cout << "    {\"name\":\"" << c.name << "\",\"status\":" << static_cast<unsigned>(c.status)
                  << ",\"allocationsBeforeRejection\":" << c.allocations
                  << ",\"allocatedBytesBeforeRejection\":" << c.bytes
                  << ",\"correctRejection\":" << (c.correctRejection ? "true" : "false") << "}"
                  << (i == 3 ? "\n" : ",\n");
    }
    std::cout << "  ],\n  \"defectReproduced\":" << (reproduced ? "true" : "false") << "\n}\n";
    return reproduced ? 0 : 1;
}
