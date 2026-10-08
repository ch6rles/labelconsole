#pragma once

#include <atomic>

// Counts heap allocations made on a thread while it is marked as "in the
// audio callback". The global operator new/delete replacements live in
// AllocationGuard.cpp.
namespace reftest
{
extern thread_local bool inAudioCallback;
extern std::atomic<long> audioAllocations;

struct ScopedAudioThread
{
    ScopedAudioThread() { inAudioCallback = true; }
    ~ScopedAudioThread() { inAudioCallback = false; }
};
} // namespace reftest
