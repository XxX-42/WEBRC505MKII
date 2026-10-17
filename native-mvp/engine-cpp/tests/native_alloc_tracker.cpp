#include "native_alloc_tracker.hpp"

#include <cstdlib>
#include <new>

namespace {
bool tracking = false;
std::size_t allocations = 0;
}

void* operator new(std::size_t size) {
    if (tracking) {
        ++allocations;
    }
    if (void* memory = std::malloc(size == 0 ? 1 : size)) {
        return memory;
    }
    throw std::bad_alloc();
}

void* operator new[](std::size_t size) {
    if (tracking) {
        ++allocations;
    }
    if (void* memory = std::malloc(size == 0 ? 1 : size)) {
        return memory;
    }
    throw std::bad_alloc();
}

void operator delete(void* memory) noexcept { std::free(memory); }
void operator delete[](void* memory) noexcept { std::free(memory); }
void operator delete(void* memory, std::size_t) noexcept { std::free(memory); }
void operator delete[](void* memory, std::size_t) noexcept { std::free(memory); }

namespace webrc::native::test_alloc {

std::size_t count() noexcept {
    return allocations;
}

void beginTracking() noexcept {
    tracking = true;
}

void endTracking() noexcept {
    tracking = false;
}

} // namespace webrc::native::test_alloc
