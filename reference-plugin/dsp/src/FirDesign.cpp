#include "ref/dsp/FirDesign.h"

#include "ref/dsp/FFT.h"

#include <cmath>
#include <numbers>

namespace ref::dsp
{

LinearPhaseSizing linearPhaseSizing (double sampleRate)
{
    LinearPhaseSizing s;
    const double ratio = sampleRate / 48000.0;
    s.latencySamples = (int) std::lround (4096.0 * ratio);
    s.nominalTaps = 2 * s.latencySamples;

    int partition = 256;
    if (ratio > 1.5)
        partition = 512;
    if (ratio > 3.0)
        partition = 1024;
    if (ratio > 6.0)
        partition = 2048;
    s.partitionSize = partition;
    s.halfLength = s.latencySamples - partition;
    return s;
}

std::vector<double> designLinearPhaseFir (const std::function<double (double)>& dbAt, double fs, int halfLength)
{
    const int taps = 2 * halfLength + 1;
    const int M = nextPowerOfTwo (taps) * 4;
    FFT fft (M);

    std::vector<std::complex<double>> spec ((size_t) M);
    for (int k = 0; k <= M / 2; ++k)
    {
        const double hz = (double) k * fs / M;
        const double mag = std::pow (10.0, dbAt (hz) / 20.0);
        spec[(size_t) k] = mag;
        if (k > 0 && k < M / 2)
            spec[(size_t) (M - k)] = mag;
    }
    fft.inverse (spec.data());

    // Zero-phase impulse is circular around index 0; take -half .. +half.
    std::vector<double> h ((size_t) taps);
    const double pi = std::numbers::pi;
    for (int j = -halfLength; j <= halfLength; ++j)
    {
        // Tukey taper (cosine over the outer quarter at each end). Its narrow
        // main lobe keeps the low end accurate: measured against the
        // correction curve it stays within 0.02 dB from 20 Hz to 20 kHz,
        // where Hann or Blackman-Harris smear 0.2-0.3 dB at 20 Hz.
        const double x = (double) (j + halfLength) / (taps - 1);
        constexpr double taper = 0.25;
        double w = 1.0;
        if (x < taper)
            w = 0.5 - 0.5 * std::cos (pi * x / taper);
        else if (x > 1.0 - taper)
            w = 0.5 - 0.5 * std::cos (pi * (1.0 - x) / taper);
        h[(size_t) (j + halfLength)] = spec[(size_t) ((j + M) % M)].real() * w;
    }
    return h;
}

} // namespace ref::dsp
