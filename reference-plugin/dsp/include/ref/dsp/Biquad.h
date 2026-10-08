#pragma once

#include "Types.h"

#include <complex>

namespace ref::dsp
{

// Squared magnitude of a filter's analogue prototype at a frequency.
double analogMagnitudeSquared (const FilterSpec&, double hz);
double analogMagnitudeDb (const FilterSpec&, double hz);

// Sum of the analogue responses of a filter list, in dB.
double analogCascadeDb (const FilterSpec* filters, int count, double hz);

struct BiquadCoeffs
{
    double b0 = 1.0, b1 = 0.0, b2 = 0.0, a1 = 0.0, a2 = 0.0;

    static BiquadCoeffs identity() { return {}; }
};

// Matched-magnitude design (Vicanek, "Matched Second Order Digital Filters"):
// poles by impulse invariance, numerator chosen so the digital magnitude
// equals the analogue magnitude at DC, at Nyquist and at the filter's
// frequency. Unlike a plain bilinear design it does not cramp near Nyquist,
// which matters at 44.1 and 48 kHz (spec Section 6). Falls back to a
// prewarped bilinear design when the poles sit too close to Nyquist for
// impulse invariance.
BiquadCoeffs designMatched (const FilterSpec&, double sampleRate);

// Bilinear (RBJ cookbook) design, kept for comparison and as a fallback.
BiquadCoeffs designBilinear (const FilterSpec&, double sampleRate);

std::complex<double> digitalResponse (const BiquadCoeffs&, double hz, double sampleRate);
double digitalMagnitudeDb (const BiquadCoeffs&, double hz, double sampleRate);

// Coefficient-wise linear interpolation between two designs.
inline BiquadCoeffs lerp (const BiquadCoeffs& a, const BiquadCoeffs& b, double t) noexcept
{
    return { a.b0 + (b.b0 - a.b0) * t, a.b1 + (b.b1 - a.b1) * t, a.b2 + (b.b2 - a.b2) * t,
             a.a1 + (b.a1 - a.a1) * t, a.a2 + (b.a2 - a.a2) * t };
}

// Transposed direct form II, double precision state.
struct BiquadState
{
    double z1 = 0.0, z2 = 0.0;

    void reset() noexcept { z1 = z2 = 0.0; }

    inline double process (const BiquadCoeffs& c, double x) noexcept
    {
        const double y = c.b0 * x + z1;
        z1 = c.b1 * x - c.a1 * y + z2;
        z2 = c.b2 * x - c.a2 * y;
        return y;
    }
};

} // namespace ref::dsp
