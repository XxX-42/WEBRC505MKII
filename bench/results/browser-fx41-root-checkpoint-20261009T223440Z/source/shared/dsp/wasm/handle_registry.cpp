#include "handle_registry.hpp"

#include <cstdlib>
#include <limits>
#include <utility>

namespace webrc::dsp::wasm {
namespace {

constexpr std::uint32_t kSlotBits = 10U;
constexpr std::uint32_t kSlotMask = (1U << kSlotBits) - 1U;
constexpr std::uint32_t kGenerationMask = (1U << (32U - kSlotBits)) - 1U;
constexpr std::uint32_t kAllocatorAllowance = 1024U;
constexpr std::uint32_t kMaximumTransferFrames = 1U << 20U;

void freePayload(void* payload) noexcept {
    std::free(payload);
}

HandleRegistry gRegistry;

} // namespace

HandleRegistry::Reservation::~Reservation() {
    if (owner_) owner_->cancel(*this);
}

HandleRegistry::Reservation::Reservation(Reservation&& other) noexcept
    : owner_(other.owner_), slot_(other.slot_), bytes_(other.bytes_) {
    other.owner_ = nullptr;
}

HandleRegistry::Reservation& HandleRegistry::Reservation::operator=(Reservation&& other) noexcept {
    if (this == &other) return *this;
    if (owner_) owner_->cancel(*this);
    owner_ = other.owner_;
    slot_ = other.slot_;
    bytes_ = other.bytes_;
    other.owner_ = nullptr;
    return *this;
}

std::int32_t HandleRegistry::reserve(std::uint32_t accountedBytes,
                                     Reservation& output) noexcept {
    if (output.owner_ != nullptr || accountedBytes == 0U) return HandleBadArgument;
    std::uint32_t slot = 0;
    while (slot < kHandleCount &&
           (slots_[slot].payload != nullptr || slots_[slot].reserved)) {
        ++slot;
    }
    if (slot == kHandleCount) return HandleNoSlots;
    if (accountedBytes > kCapacityBytes || managedBytes_ > kCapacityBytes - accountedBytes) {
        return HandleMemoryBudget;
    }
    managedBytes_ += accountedBytes;
    slots_[slot].reserved = true;
    output.owner_ = this;
    output.slot_ = slot;
    output.bytes_ = accountedBytes;
    return HandleOk;
}

std::uint32_t HandleRegistry::publish(Reservation& reservation, HandleDomain domain,
                                      std::uint32_t kind, const ProcessSpec& spec,
                                      void* payload, DestroyPayload destroy) noexcept {
    if (reservation.owner_ != this || reservation.slot_ >= kHandleCount ||
        !payload || !destroy) return 0U;
    auto& slot = slots_[reservation.slot_];
    if (!slot.reserved || slot.payload != nullptr) return 0U;
    slot.payload = payload;
    slot.destroy = destroy;
    slot.kind = kind;
    slot.domain = domain;
    slot.spec = spec;
    slot.bytes = reservation.bytes_;
    slot.reserved = false;
    const auto handle = encodeHandle(reservation.slot_);
    reservation.owner_ = nullptr;
    reservation.slot_ = 0U;
    reservation.bytes_ = 0U;
    return handle;
}

std::int32_t HandleRegistry::lookup(std::uint32_t handle, HandleView& output) const noexcept {
    if (handle == 0U) return HandleBadHandle;
    const auto slotIndex = handle & kSlotMask;
    const auto generation = handle >> kSlotBits;
    if (slotIndex >= kHandleCount || generation == 0U) return HandleBadHandle;
    const auto& slot = slots_[slotIndex];
    if (slot.payload == nullptr || slot.reserved || slot.generation != generation) {
        return HandleBadHandle;
    }
    output.payload = slot.payload;
    output.domain = slot.domain;
    output.kind = slot.kind;
    output.spec = slot.spec;
    output.accountedBytes = slot.bytes;
    return HandleOk;
}

std::int32_t HandleRegistry::destroy(std::uint32_t handle,
                                     HandleDomain expectedDomain) noexcept {
    HandleView view{};
    const auto status = lookup(handle, view);
    if (status != HandleOk) return status;
    if (view.domain != expectedDomain) return HandleBadKind;
    const auto slotIndex = handle & kSlotMask;
    auto& slot = slots_[slotIndex];
    slot.destroy(slot.payload);
    managedBytes_ -= slot.bytes;
    const auto generation = nextGeneration(slot.generation);
    slot = {};
    slot.generation = generation;
    return HandleOk;
}

std::uint32_t HandleRegistry::allocateTransferF32(std::uint32_t frames) noexcept {
    std::uint32_t address = 0U;
    (void)allocateTransferF32Token(frames, address);
    return address;
}

std::uint32_t HandleRegistry::allocateTransferF32Token(std::uint32_t frames,
                                                       std::uint32_t& address) noexcept {
    address = 0U;
    if (frames == 0U || frames > kMaximumTransferFrames ||
        frames > (std::numeric_limits<std::uint32_t>::max() - kAllocatorAllowance) / sizeof(float)) {
        return 0U;
    }
    const auto bytes = frames * static_cast<std::uint32_t>(sizeof(float));
    Reservation reservation{};
    if (reserve(bytes + kAllocatorAllowance, reservation) != HandleOk) return 0U;
    auto* memory = std::malloc(bytes);
    if (!memory) return 0U;
    const auto handle = publish(reservation, HandleDomain::Transfer, 1U, {}, memory, freePayload);
    if (handle == 0U) {
        std::free(memory);
        return 0U;
    }
    address = static_cast<std::uint32_t>(reinterpret_cast<std::uintptr_t>(memory));
    return handle;
}

std::uint32_t HandleRegistry::transferAddress(std::uint32_t token) const noexcept {
    HandleView view{};
    if (lookup(token, view) != HandleOk || view.domain != HandleDomain::Transfer) return 0U;
    return static_cast<std::uint32_t>(reinterpret_cast<std::uintptr_t>(view.payload));
}

std::int32_t HandleRegistry::freeTransferToken(std::uint32_t token) noexcept {
    return destroy(token, HandleDomain::Transfer);
}

void HandleRegistry::freeTransfer(std::uint32_t address) noexcept {
    if (address == 0U) return;
    const auto* target = reinterpret_cast<void*>(static_cast<std::uintptr_t>(address));
    for (std::uint32_t index = 0; index < kHandleCount; ++index) {
        const auto& slot = slots_[index];
        if (slot.payload == target && slot.domain == HandleDomain::Transfer) {
            (void)destroy(encodeHandle(index), HandleDomain::Transfer);
            return;
        }
    }
}

void HandleRegistry::cancel(Reservation& reservation) noexcept {
    if (reservation.owner_ != this) return;
    if (reservation.slot_ < kHandleCount) {
        auto& slot = slots_[reservation.slot_];
        if (slot.reserved && slot.payload == nullptr) {
            slot.reserved = false;
            managedBytes_ -= reservation.bytes_;
        }
    }
    reservation.owner_ = nullptr;
    reservation.slot_ = 0U;
    reservation.bytes_ = 0U;
}

std::uint32_t HandleRegistry::encodeHandle(std::uint32_t slot) const noexcept {
    return (slots_[slot].generation << kSlotBits) | slot;
}

std::uint32_t HandleRegistry::nextGeneration(std::uint32_t generation) noexcept {
    generation = (generation + 1U) & kGenerationMask;
    return generation == 0U ? 1U : generation;
}

HandleRegistry& registry() noexcept {
    return gRegistry;
}

} // namespace webrc::dsp::wasm
