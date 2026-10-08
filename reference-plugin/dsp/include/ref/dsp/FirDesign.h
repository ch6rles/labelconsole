#pragma once

#include <functional>
#include <vector>

namespace ref::dsp
{

// Linear Phase sizing (spec Section 6): 8,192 taps at 48 kHz, scaled with
// the sample rate so the latency in milliseconds stays the same.
struct LinearPhaseSizing
{
    int nominalTaps = 8192;   // what the UI reports
    int latencySamples = 4096; // nominalTaps / 2
    int partitionSize = 256;   // convolver block
    int halfLength = 3840;     // FIR half length; latency = partition + half
};

LinearPhaseSizing linearPhaseSizing (double sampleRate);

// Designs a symmetric (linear-phase) FIR of 2 * halfLength + 1 taps whose
// magnitude follows dbAt(hz) for 0 .. Nyquist, by frequency sampling on a
// fine grid and a Tukey taper. The impulse is centred at
// tap `halfLength`.
std::vector<double> designLinearPhaseFir (const std::function<double (double hz)>& dbAt, double sampleRate, int halfLength);

} // namespace ref::dsp
