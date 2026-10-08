#include "ref/dsp/Loudness.h"

#include "ref/dsp/Grid.h"

#include <algorithm>
#include <cmath>
#include <numbers>

namespace ref::dsp
{

namespace
{
// BS.1770-4 coefficients at 48 kHz.
constexpr BiquadCoeffs kShelf48 { 1.53512485958697, -2.69169618940638, 1.19839281085285, -1.69065929318241, 0.73248077421585 };
constexpr BiquadCoeffs kHighPass48 { 1.0, -2.0, 1.0, -1.99004745483398, 0.99007225036621 };
} // namespace

std::array<BiquadCoeffs, 2> kWeightingCoeffs (double fs)
{
    if (fs == 48000.0)
        return { kShelf48, kHighPass48 };

    // Analogue parameters behind the 48 kHz coefficients (as derived by
    // libebur128 and others), re-discretised with the bilinear transform.
    const double pi = std::numbers::pi;
    std::array<BiquadCoeffs, 2> out;
    {
        const double f0 = 1681.974450955533, G = 3.999843853973347, Q = 0.7071752369554196;
        const double K = std::tan (pi * f0 / fs);
        const double Vh = std::pow (10.0, G / 20.0);
        const double Vb = std::pow (Vh, 0.4996667741545416);
        const double a0 = 1.0 + K / Q + K * K;
        out[0] = { (Vh + Vb * K / Q + K * K) / a0, 2.0 * (K * K - Vh) / a0, (Vh - Vb * K / Q + K * K) / a0,
                   2.0 * (K * K - 1.0) / a0, (1.0 - K / Q + K * K) / a0 };
    }
    {
        const double f0 = 38.13547087602444, Q = 0.5003270373238773;
        const double K = std::tan (pi * f0 / fs);
        const double a0 = 1.0 + K / Q + K * K;
        out[1] = { 1.0, -2.0, 1.0, 2.0 * (K * K - 1.0) / a0, (1.0 - K / Q + K * K) / a0 };
    }
    return out;
}

double kWeightingPower (double hz)
{
    const double f = std::min (hz, 23999.0);
    const auto a = std::abs (digitalResponse (kShelf48, f, 48000.0));
    const auto b = std::abs (digitalResponse (kHighPass48, f, 48000.0));
    return a * a * b * b;
}

double loudnessMatchGainDb (const GridCurve& responseDb)
{
    static const GridCurve weights = []
    {
        GridCurve w {};
        for (int i = 0; i < kGridSize; ++i)
            w[(size_t) i] = kWeightingPower (gridFrequency (i));
        return w;
    }();

    double num = 0.0, den = 0.0;
    for (int i = 0; i < kGridSize; ++i)
    {
        num += weights[(size_t) i] * std::pow (10.0, responseDb[(size_t) i] / 10.0);
        den += weights[(size_t) i];
    }
    return -10.0 * std::log10 (num / den);
}

double headroomDb (const GridCurve& responseDb, double matchGainDb)
{
    double peak = -1e9;
    for (double v : responseDb)
        peak = std::max (peak, v + matchGainDb);
    return std::min (0.0, -peak);
}

double measureLoudnessDb (const float* const* channels, int numChannels, int numSamples, double fs)
{
    const auto k = kWeightingCoeffs (fs);
    double total = 0.0;
    for (int ch = 0; ch < numChannels; ++ch)
    {
        BiquadState s1, s2;
        double sum = 0.0;
        for (int n = 0; n < numSamples; ++n)
        {
            const double y = s2.process (k[1], s1.process (k[0], (double) channels[ch][n]));
            sum += y * y;
        }
        total += sum / std::max (numSamples, 1);
    }
    return -0.691 + 10.0 * std::log10 (std::max (total, 1e-30));
}

} // namespace ref::dsp
