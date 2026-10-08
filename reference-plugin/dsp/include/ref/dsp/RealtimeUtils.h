#pragma once

#include <algorithm>
#include <array>
#include <atomic>
#include <cmath>
#include <cstddef>
#include <cstdint>

#if defined(__SSE__) || defined(_M_X64) || defined(_M_IX86)
 #include <xmmintrin.h>
 #define REF_DSP_SSE 1
#endif

namespace ref::dsp
{

// Two cascaded one-pole smoothers. Unlike a linear ramp the output has a
// continuous slope, so even a 36 dB move inside 10 ms leaves no kink in the
// waveform (spec Section 12, "Smoothing").
class Smoother2
{
public:
    void setTimeConstant (double seconds, double sampleRate) noexcept
    {
        k = 1.0 - std::exp (-1.0 / std::max (seconds * sampleRate, 1.0));
    }

    void reset (double value) noexcept { s1 = s2 = value; }

    double next (double target) noexcept
    {
        s1 += k * (target - s1);
        s2 += k * (s1 - s2);
        return s2;
    }

    double current() const noexcept { return s2; }

    // True when both stages are within `eps` of the target.
    bool settledAt (double target, double eps) const noexcept
    {
        return std::abs (s1 - target) < eps && std::abs (s2 - target) < eps;
    }

private:
    double k = 1.0, s1 = 0.0, s2 = 0.0;
};

// A 0..1 position that moves at a fixed rate, read through a raised-cosine
// curve: used for A/B, Bypass and filter-set crossfades (about 20-50 ms).
class Crossfade
{
public:
    void setDuration (double seconds, double sampleRate) noexcept
    {
        step = 1.0 / std::max (seconds * sampleRate, 1.0);
    }

    void snap (bool on) noexcept { pos = on ? 1.0 : 0.0; }
    bool isSettled (bool on) const noexcept { return pos == (on ? 1.0 : 0.0); }

    double next (bool on) noexcept
    {
        pos = on ? std::min (1.0, pos + step) : std::max (0.0, pos - step);
        return gain();
    }

    double gain() const noexcept { return 0.5 - 0.5 * std::cos (3.14159265358979323846 * pos); }
    double position() const noexcept { return pos; }

private:
    double step = 1.0, pos = 0.0;
};

// Monitor Protection (spec Section 7): soft-knee clipper, transparent below
// about -1 dBFS, approaching a -0.1 dBFS ceiling it never exceeds. No
// lookahead, so no latency.
struct ProtectionClipper
{
    static constexpr double knee = 0.8912509381337456;    // -1 dBFS
    static constexpr double ceiling = 0.9885530946569389; // -0.1 dBFS

    static inline double process (double x, bool& engaged) noexcept
    {
        const double a = std::abs (x);
        if (a <= knee)
            return x;
        engaged = true;
        const double range = ceiling - knee;
        const double y = knee + range * std::tanh ((a - knee) / range);
        return x < 0.0 ? -y : y;
    }
};

// Single-producer single-consumer pointer queue with fixed capacity.
template <typename T, size_t Capacity>
class SpscPointerQueue
{
public:
    bool push (T* item) noexcept
    {
        const auto w = writeIndex.load (std::memory_order_relaxed);
        const auto next = (w + 1) % Capacity;
        if (next == readIndex.load (std::memory_order_acquire))
            return false;
        slots[w] = item;
        writeIndex.store (next, std::memory_order_release);
        return true;
    }

    T* pop() noexcept
    {
        const auto r = readIndex.load (std::memory_order_relaxed);
        if (r == writeIndex.load (std::memory_order_acquire))
            return nullptr;
        T* item = slots[r];
        readIndex.store ((r + 1) % Capacity, std::memory_order_release);
        return item;
    }

private:
    std::array<T*, Capacity> slots {};
    std::atomic<size_t> writeIndex { 0 }, readIndex { 0 };
};

// Flush-to-zero / denormals-are-zero for the scope (x86 and arm64).
class ScopedFlushDenormals
{
public:
    ScopedFlushDenormals() noexcept
    {
#if REF_DSP_SSE
        saved = _mm_getcsr();
        _mm_setcsr ((unsigned int) saved | 0x8040u);
#elif defined(__aarch64__)
        uint64_t fpcr;
        asm volatile ("mrs %0, fpcr" : "=r"(fpcr));
        saved = fpcr;
        asm volatile ("msr fpcr, %0" : : "r"(fpcr | (1ull << 24)));
#endif
    }

    ~ScopedFlushDenormals() noexcept
    {
#if REF_DSP_SSE
        _mm_setcsr ((unsigned int) saved);
#elif defined(__aarch64__)
        asm volatile ("msr fpcr, %0" : : "r"(saved));
#endif
    }

    ScopedFlushDenormals (const ScopedFlushDenormals&) = delete;
    ScopedFlushDenormals& operator= (const ScopedFlushDenormals&) = delete;

private:
    uint64_t saved = 0;
};

// Lock-free "max since last read" for meters.
inline void atomicStoreMax (std::atomic<float>& target, float value) noexcept
{
    float prev = target.load (std::memory_order_relaxed);
    while (value > prev && ! target.compare_exchange_weak (prev, value, std::memory_order_relaxed))
    {
    }
}

} // namespace ref::dsp
