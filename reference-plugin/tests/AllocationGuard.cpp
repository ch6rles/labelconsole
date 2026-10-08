#include "AllocationGuard.h"

#include <cstdlib>
#include <new>

namespace reftest
{
thread_local bool inAudioCallback = false;
std::atomic<long> audioAllocations { 0 };
} // namespace reftest

namespace
{
void* allocate (std::size_t n)
{
    if (reftest::inAudioCallback)
        reftest::audioAllocations.fetch_add (1);
    if (void* p = std::malloc (n == 0 ? 1 : n))
        return p;
    throw std::bad_alloc();
}

void release (void* p) noexcept
{
    if (p != nullptr && reftest::inAudioCallback)
        reftest::audioAllocations.fetch_add (1);
    std::free (p);
}
} // namespace

void* operator new (std::size_t n) { return allocate (n); }
void* operator new[] (std::size_t n) { return allocate (n); }
void* operator new (std::size_t n, const std::nothrow_t&) noexcept
{
    try { return allocate (n); } catch (...) { return nullptr; }
}
void* operator new[] (std::size_t n, const std::nothrow_t&) noexcept
{
    try { return allocate (n); } catch (...) { return nullptr; }
}
void operator delete (void* p) noexcept { release (p); }
void operator delete[] (void* p) noexcept { release (p); }
void operator delete (void* p, std::size_t) noexcept { release (p); }
void operator delete[] (void* p, std::size_t) noexcept { release (p); }
