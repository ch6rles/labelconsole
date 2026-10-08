#pragma once

#include <complex>
#include <vector>

namespace ref::dsp
{

// Radix-2 complex FFT, double precision, in place. Tables are built in the
// constructor; transforms never allocate, so prepared instances are safe to
// use on the audio thread.
class FFT
{
public:
    explicit FFT (int size); // power of two, >= 2

    int size() const noexcept { return n; }

    void forward (std::complex<double>* data) const noexcept;
    void inverse (std::complex<double>* data) const noexcept; // scaled by 1/size

private:
    void transform (std::complex<double>* data, bool inverse) const noexcept;

    int n;
    std::vector<std::complex<double>> twiddles;
    std::vector<int> bitReverse;
};

int nextPowerOfTwo (int v);

// Plain complex multiply. std::complex's operator* goes through the
// NaN-recovering __muldc3 path unless fast-math is on, which is several
// times slower in the convolution loop.
inline std::complex<double> cmul (std::complex<double> a, std::complex<double> b) noexcept
{
    return { a.real() * b.real() - a.imag() * b.imag(), a.real() * b.imag() + a.imag() * b.real() };
}

} // namespace ref::dsp
