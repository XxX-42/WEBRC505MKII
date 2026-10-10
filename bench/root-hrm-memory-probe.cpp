#include "webrc/dsp/pitch_fx_adapter.hpp"
#include <algorithm>
#include <cstddef>
#include <cstdio>
#include <cstdlib>
#include <new>

namespace {
struct alignas(std::max_align_t) AllocationHeader { std::size_t bytes; };
std::size_t liveBytes = 0, peakBytes = 0, allocations = 0;
}
void* operator new(std::size_t bytes) {
    bytes = std::max<std::size_t>(bytes, 1);
    auto* header = static_cast<AllocationHeader*>(std::malloc(sizeof(AllocationHeader) + bytes));
    if (!header) throw std::bad_alloc();
    header->bytes = bytes;
    liveBytes += bytes;
    peakBytes = std::max(peakBytes, liveBytes);
    ++allocations;
    return header + 1;
}
void* operator new[](std::size_t bytes) { return ::operator new(bytes); }
void operator delete(void* pointer) noexcept {
    if (!pointer) return;
    auto* header = static_cast<AllocationHeader*>(pointer) - 1;
    liveBytes -= header->bytes;
    std::free(header);
}
void operator delete[](void* pointer) noexcept { ::operator delete(pointer); }
void operator delete(void* pointer, std::size_t) noexcept { ::operator delete(pointer); }
void operator delete[](void* pointer, std::size_t) noexcept { ::operator delete(pointer); }

int main() {
    using namespace webrc::dsp;
    std::printf("{\"scope\":\"Native single-thread C++ ordinary new payload counters; excludes allocator overhead, direct C allocations, aligned-new allocations and WASM heap\",\"cases\":[");
    bool first = true;
    for (unsigned profile : {1U, 2U}) for (unsigned frames : {64U, 128U, 1024U}) {
        const auto baseline = liveBytes;
        {
            PitchFxAdapter processor(18);
            const ProcessSpec spec{48000.0f, frames, 2};
            if (!processor.setParameter(FxParameterId::PitchProfile, float(profile))) return 2;
            FxParameterEvent event{0, FxParameterId::PitchProfile, float(profile)};
            const auto estimated = fxMemoryRequirementForParameters(18, spec, &event, 1);
            peakBytes = liveBytes;
            const auto countBefore = allocations;
            if (!processor.prepare(spec)) return 3;
            const auto persistent = liveBytes - baseline;
            const auto initialPeak = peakBytes - baseline;
            const auto initialAllocations = allocations - countBefore;
            peakBytes = liveBytes;
            if (!processor.prepare(spec)) return 4;
            const auto replacementPeak = peakBytes - baseline;
            if (!first) std::printf(",");
            first = false;
            std::printf("{\"profile\":%u,\"frames\":%u,\"persistentNewPayloadBytes\":%llu,\"initialPreparePeakNewPayloadBytes\":%llu,\"repreparePeakNewPayloadBytes\":%llu,\"initialAllocations\":%llu,\"estimatedPreparedStateBytes\":%llu,\"estimatedPeakBytes\":%llu}", profile, frames,
                (unsigned long long)persistent, (unsigned long long)initialPeak,
                (unsigned long long)replacementPeak, (unsigned long long)initialAllocations,
                (unsigned long long)estimated.persistentPreparedBytes,
                (unsigned long long)estimated.peakBytes());
        }
        if (liveBytes != baseline) return 5;
    }
    std::printf("],\"allCasesReturnedToBaseline\":true}\n");
}
