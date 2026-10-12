#pragma once

#include <functional>
#include <vector>

namespace ref::dsp
{

// Linear Phase sizing (spec Section 6): the latency of an 8,192-tap filter
// at 48 kHz (4,096 samples, 85.3 ms), scaled with the sample rate so the
// latency in milliseconds stays the same. The convolver's partition comes
// out of that budget, so the FIR itself is 2 * (latency - partition) + 1
// taps: 7,681 at 48 kHz.
struct LinearPhaseSizing
{
    int latencySamples = 4096; // reported latency
    int partitionSize = 256;   // convolver block
    int halfLength = 3840;     // FIR half length; latency = partition + half
    int taps = 7681;           // 2 * halfLength + 1
};

LinearPhaseSizing linearPhaseSizing (double sampleRate);

// Designs a symmetric (linear-phase) FIR of 2 * halfLength + 1 taps whose
// magnitude follows dbAt(hz) for 0 .. Nyquist, by frequency sampling on a
// fine grid and a Tukey taper. The impulse is centred at
// tap `halfLength`.
std::vector<double> designLinearPhaseFir (const std::function<double (double hz)>& dbAt, double sampleRate, int halfLength);

} // namespace ref::dsp
