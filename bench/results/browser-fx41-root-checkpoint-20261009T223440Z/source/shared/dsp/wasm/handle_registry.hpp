#pragma once

#include "webrc/dsp/primitives.hpp"

#include <cstddef>
#include <cstdint>

namespace webrc::dsp::wasm {

enum class HandleDomain : std::uint8_t { Base = 1, Extended = 2, Transfer = 3, Fx = 4 };

enum HandleStatus : std::int32_t {
    HandleOk = 0,
    HandleBadHandle = -1,
    HandleBadArgument = -2,
    HandleBadKind = -3,
    HandleBlockTooLarge = -4,
    HandleNoSlots = -5,
    HandlePrepareFailed = -6,
    HandleMemoryBudget = -7,
    HandleAllocationFailed = -8,
};

struct HandleView {
    void* payload = nullptr;
    HandleDomain domain = HandleDomain::Base;
    std::uint32_t kind = 0;
    ProcessSpec spec{};
    std::uint32_t accountedBytes = 0;
};

class HandleRegistry {
public:
    static constexpr std::uint32_t kCapacityBytes = 48U * 1024U * 1024U;
    static constexpr std::uint32_t kHandleCount = 1024U;
    static constexpr std::uint32_t kTransferLimitBytes = 4U * 1024U * 1024U;
    using DestroyPayload = void (*)(void*) noexcept;

    class Reservation {
    public:
        Reservation() noexcept = default;
        ~Reservation();
        Reservation(const Reservation&) = delete;
        Reservation& operator=(const Reservation&) = delete;
        Reservation(Reservation&& other) noexcept;
        Reservation& operator=(Reservation&& other) noexcept;
        [[nodiscard]] explicit operator bool() const noexcept { return owner_ != nullptr; }

    private:
        friend class HandleRegistry;
        HandleRegistry* owner_ = nullptr;
        std::uint32_t slot_ = 0;
        std::uint32_t bytes_ = 0;
    };

    [[nodiscard]] std::int32_t reserve(std::uint32_t accountedBytes,
                                       Reservation& output) noexcept;
    [[nodiscard]] std::uint32_t publish(Reservation& reservation, HandleDomain domain,
                                        std::uint32_t kind, const ProcessSpec& spec,
                                        void* payload, DestroyPayload destroy) noexcept;
    [[nodiscard]] std::int32_t lookup(std::uint32_t handle, HandleView& output) const noexcept;
    [[nodiscard]] std::int32_t destroy(std::uint32_t handle,
                                       HandleDomain expectedDomain) noexcept;
    [[nodiscard]] std::uint32_t allocateTransferF32(std::uint32_t frames) noexcept;
    [[nodiscard]] std::uint32_t allocateTransferF32Token(std::uint32_t frames,
                                                         std::uint32_t& address) noexcept;
    [[nodiscard]] std::uint32_t transferAddress(std::uint32_t token) const noexcept;
    [[nodiscard]] std::int32_t freeTransferToken(std::uint32_t token) noexcept;
    void freeTransfer(std::uint32_t address) noexcept;
    [[nodiscard]] std::uint32_t managedBytes() const noexcept { return managedBytes_; }
    [[nodiscard]] static constexpr std::uint32_t capacityBytes() noexcept { return kCapacityBytes; }

private:
    struct Slot {
        void* payload = nullptr;
        DestroyPayload destroy = nullptr;
        std::uint32_t generation = 1;
        std::uint32_t kind = 0;
        std::uint32_t bytes = 0;
        ProcessSpec spec{};
        HandleDomain domain = HandleDomain::Base;
        bool reserved = false;
    };

    void cancel(Reservation& reservation) noexcept;
    [[nodiscard]] std::uint32_t encodeHandle(std::uint32_t slot) const noexcept;
    [[nodiscard]] static std::uint32_t nextGeneration(std::uint32_t generation) noexcept;
    Slot slots_[kHandleCount]{};
    std::uint32_t managedBytes_ = 0;
};

[[nodiscard]] HandleRegistry& registry() noexcept;

} // namespace webrc::dsp::wasm
