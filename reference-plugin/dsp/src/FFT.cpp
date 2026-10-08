#include "ref/dsp/FFT.h"

#include <cmath>
#include <numbers>
#include <utility>

namespace ref::dsp
{

int nextPowerOfTwo (int v)
{
    int p = 1;
    while (p < v)
        p <<= 1;
    return p;
}

FFT::FFT (int size) : n (size)
{
    twiddles.resize ((size_t) n / 2);
    for (int i = 0; i < n / 2; ++i)
        twiddles[(size_t) i] = std::polar (1.0, -2.0 * std::numbers::pi * i / n);

    int bits = 0;
    while ((1 << bits) < n)
        ++bits;
    bitReverse.resize ((size_t) n);
    for (int i = 0; i < n; ++i)
    {
        int r = 0;
        for (int b = 0; b < bits; ++b)
            if (i & (1 << b))
                r |= 1 << (bits - 1 - b);
        bitReverse[(size_t) i] = r;
    }
}

void FFT::forward (std::complex<double>* data) const noexcept
{
    transform (data, false);
}

void FFT::inverse (std::complex<double>* data) const noexcept
{
    transform (data, true);
    const double scale = 1.0 / n;
    for (int i = 0; i < n; ++i)
        data[i] *= scale;
}

void FFT::transform (std::complex<double>* data, bool inv) const noexcept
{
    for (int i = 0; i < n; ++i)
    {
        const int r = bitReverse[(size_t) i];
        if (r > i)
            std::swap (data[i], data[r]);
    }

    for (int len = 2; len <= n; len <<= 1)
    {
        const int half = len >> 1;
        const int stride = n / len;
        for (int start = 0; start < n; start += len)
        {
            for (int k = 0; k < half; ++k)
            {
                auto w = twiddles[(size_t) (k * stride)];
                if (inv)
                    w = std::conj (w);
                const auto u = data[start + k];
                const auto v = cmul (data[start + k + half], w);
                data[start + k] = u + v;
                data[start + k + half] = u - v;
            }
        }
    }
}

} // namespace ref::dsp
